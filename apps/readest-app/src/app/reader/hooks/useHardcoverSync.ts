import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';
import { HardcoverClient, getHardcoverCircuitState, checkAndClearHardcoverRecovery, markHardcoverDisconnectNotified } from '@/services/sync/HardcoverClient';
import { Book, FIXED_LAYOUT_FORMATS } from '@/types/book';
import { HardcoverConflictData } from '@/services/sync/hardcoverTypes';
import { debounce } from '@/utils/debounce';
import { eventDispatcher } from '@/utils/event';

type SyncState = 'idle' | 'checking' | 'conflict' | 'synced' | 'error' | 'matching';

// Module-level registry for active sync promises
const activeSyncPromises = new Map<string, Promise<void>>();

// Module-level registry for forceSync functions
const forceSyncFunctions = new Map<string, () => Promise<void>>();

/**
 * Get active sync promise for a bookKey
 */
export const getHardcoverActiveSyncPromise = (bookKey: string): Promise<void> | null => {
  return activeSyncPromises.get(bookKey) || null;
};

/**
 * Force sync for a specific bookKey (call directly before navigation)
 */
export const forceHardcoverSync = async (bookKey: string): Promise<void> => {
  const forceSync = forceSyncFunctions.get(bookKey);
  if (forceSync) {
    console.log(`[Hardcover] Calling forceSync for bookKey: ${bookKey}`);
    await forceSync();
  }
};

export interface HardcoverSyncDetails {
  book: Book;
  conflict: HardcoverConflictData;
  // Metadata for page mapping (EPUBs only)
  isFixedLayout: boolean;
  localTotalPages: number;
  remotePageRaw: number;
}

export const useHardcoverSync = (bookKey: string) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const { getProgress } = useReaderStore();
  const { getBookData, getConfig, setConfig } = useBookDataStore();

  const [hardcoverClient, setHardcoverClient] = useState<HardcoverClient | null>(null);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [needsMatching, setNeedsMatching] = useState(false);
  const [conflictDetails, setConflictDetails] = useState<HardcoverSyncDetails | null>(null);
  const hasPulledOnce = useRef(false);
  const hasSetCurrentlyReading = useRef(false);
  const lastPercentage = useRef<number>(0);
  const isPulling = useRef(false);
  const lastSyncedSection = useRef<string | null>(null);
  const activeSyncPromise = useRef<Promise<void> | null>(null);

  const progress = getProgress(bookKey);
  const config = getConfig(bookKey);
  const { getView } = useReaderStore();

  // Debug logging helper
  const debugLog = (...args: any[]) => {
    if (settings.hardcover.debug) {
      console.log(...args);
    }
  };

  // Initialize client when settings change
  useEffect(() => {
    if (!settings.hardcover?.apiToken || !settings.hardcover.enabled) {
      setHardcoverClient(null);
      return;
    }
    const client = new HardcoverClient(settings.hardcover);
    setHardcoverClient(client);
  }, [settings]);

  /**
   * Match book with Hardcover if not already matched
   */
  const matchBook = useCallback(async () => {
    const bookData = getBookData(bookKey);
    if (!bookData || !hardcoverClient) {
      debugLog('[Hardcover] Cannot match book - missing data or client');
      return;
    }

    if (config?.hardcoverId) {
      debugLog('[Hardcover] Book already matched:', config.hardcoverId);
      return config.hardcoverId; // Already matched
    }

    debugLog('[Hardcover] Starting book matching for:', bookData.book?.title);
    setSyncState('matching');

    try {
      if (settings.hardcover.autoMatchBooks) {
        const matched = await hardcoverClient.matchBook(bookData.book!);
        if (matched) {
          // Add to user's library if not already there
          const userBook = await hardcoverClient.getUserBook(matched.id);
          let userBookId: string | null;

          if (!userBook) {
            userBookId = await hardcoverClient.addBookToLibrary(matched.id);
          } else {
            userBookId = userBook.id;
          }

          if (userBookId) {
            setConfig(bookKey, { ...config!, hardcoverId: userBookId });
            setSyncState('synced');
            return userBookId;
          }
        }
      }

      // If auto-match failed, show manual matching dialog
      setNeedsMatching(true);
      setSyncState('idle');
      return null;
    } catch (error) {
      console.error('Hardcover book matching failed:', error);
      const errorMessage = (error as Error).message;

      if (errorMessage.includes('HARDCOVER_CIRCUIT_OPEN')) {
        console.warn('[Hardcover] Book matching blocked by circuit breaker');
        setSyncState('error');
        return null;
      } else if (errorMessage.includes('AUTH_FAILED')) {
        eventDispatcher.dispatch('toast', {
          message: _('Hardcover authentication failed. Please check your API token.'),
          type: 'error',
        });
      } else if (errorMessage.includes('NETWORK')) {
        eventDispatcher.dispatch('toast', {
          message: _('Network error. Please check your connection.'),
          type: 'error',
        });
      }

      setSyncState('error');
      return null;
    }
  }, [bookKey, hardcoverClient, config, settings, getBookData, setConfig, _]);

  /**
   * Apply remote progress to local reader
   */
  const applyRemoteProgress = useCallback(
    (page: number) => {
      const view = getView(bookKey);
      if (!view) {
        console.warn('[Hardcover] Cannot apply remote progress - no view');
        return;
      }

      const currentProgress = getProgress(bookKey);
      if (!currentProgress) {
        console.warn('[Hardcover] Cannot apply remote progress - no current progress');
        return;
      }

      const bookData = getBookData(bookKey);
      if (!bookData) {
        console.warn('[Hardcover] Cannot apply remote progress - no book data');
        return;
      }

      // Hardcover uses 1-based page numbers, reader uses 0-based
      const targetPage = Math.max(0, page - 1);
      const isFixedLayout = FIXED_LAYOUT_FORMATS.has(bookData.book!.format);

      debugLog('[Hardcover] Applying remote progress:', {
        remotePage: page,
        targetPage,
        currentPage: currentProgress.pageinfo?.current || currentProgress.section?.current,
        bookFormat: bookData.book!.format,
        isFixedLayout,
      });

      // Fixed-layout (PDF) uses select() with page number
      if (isFixedLayout) {
        view.select(targetPage);
        debugLog('[Hardcover] Navigation via select() to page:', page);
      } else {
        // For reflowable (EPUB), calculate the percentage and navigate to that fraction
        const totalPages = currentProgress.pageinfo?.total || 1;
        const percentage = page / totalPages;

        debugLog('[Hardcover] Calculating position:', {
          remotePage: page,
          totalPages,
          percentage: Math.round(percentage * 100) + '%',
        });

        // Use goToFraction to navigate to a percentage of the book
        if ('goToFraction' in view) {
          (view as any).goToFraction(percentage);
          debugLog('[Hardcover] Navigation via goToFraction() to', Math.round(percentage * 100) + '%');
        } else {
          // Fallback: try to use section-based navigation
          console.warn('[Hardcover] goToFraction not available, trying section navigation');
          (view as any).select(targetPage);
        }
      }

      eventDispatcher.dispatch('toast', {
        message: _('Reading progress synced from Hardcover'),
        type: 'info',
      });
    },
    [bookKey, getView, getProgress, getBookData, _],
  );

  /**
   * Show conflict resolution dialog
   */
  const showConflictDialog = useCallback(
    (
      book: Book,
      localPercentage: number,
      localPage: number,
      remotePercentage: number,
      remotePage: number,
      remoteTimestamp: string,
      isFixedLayout: boolean,
      localTotalPages: number,
      remotePageRaw: number,
    ) => {
      const localPreview = _('Page {{page}} ({{percentage}}%)', {
        page: localPage,
        percentage: Math.round(localPercentage * 100),
      });

      const remotePreview = _('Page {{page}} ({{percentage}}%)', {
        page: remotePage,
        percentage: Math.round(remotePercentage * 100),
      });

      setConflictDetails({
        book,
        conflict: {
          local: {
            percentage: localPercentage,
            page: localPage,
            preview: localPreview,
            timestamp: config?.updatedAt || Date.now(),
          },
          remote: {
            userBookId: config?.hardcoverId || '',
            percentage: remotePercentage,
            page: remotePage,
            preview: remotePreview,
            timestamp: remoteTimestamp,
          },
        },
        // Metadata for page mapping
        isFixedLayout,
        localTotalPages,
        remotePageRaw,
      });
    },
    [config, _],
  );

  /**
   * Sync reading status to Hardcover
   */
  const syncStatus = useCallback(
    async (status: 'CURRENTLY_READING' | 'READ') => {
      if (!hardcoverClient || !config?.hardcoverId) return;

      const { enabled, syncStatus: statusSyncEnabled } = settings.hardcover;
      if (!enabled || !statusSyncEnabled) return;

      try {
        await hardcoverClient.updateStatus(config.hardcoverId, status);
      } catch (error) {
        console.error('Hardcover status sync failed:', error);
        // Silent fail to not disrupt reading
      }
    },
    [hardcoverClient, config, settings],
  );

  /**
   * Pull progress from Hardcover
   */
  const pullProgress = useCallback(async () => {
    debugLog('[Hardcover] pullProgress called', {
      hasProgress: !!progress?.location,
      hasAppService: !!appService,
      hasClient: !!hardcoverClient,
      enabled: settings.hardcover.enabled,
      syncProgress: settings.hardcover.syncProgress,
      strategy: settings.hardcover.strategy,
    });

    if (!progress?.location || !appService || !hardcoverClient) return;

    const bookData = getBookData(bookKey);
    if (!bookData) return;

    const { enabled, syncProgress, strategy } = settings.hardcover;
    if (!enabled || !syncProgress) return;

    hasPulledOnce.current = true;
    isPulling.current = true; // Block pushes while pulling

    if (strategy === 'send') {
      setSyncState('synced');
      isPulling.current = false;
      return;
    }

    try {
      // Ensure book is matched
      const hardcoverId = config?.hardcoverId || (await matchBook());
      if (!hardcoverId) {
        isPulling.current = false;
        return;
      }

      setSyncState('checking');
      debugLog('[Hardcover] Fetching user book with hardcoverId:', hardcoverId);
      const userBook = await hardcoverClient.getUserBook(hardcoverId);

      debugLog('[Hardcover] getUserBook returned:', {
        hasUserBook: !!userBook,
        userBook: userBook,
        hasProgress: !!userBook?.progress,
        progressPage: userBook?.progress?.page,
      });

      // Store readId, editionId, startedAt, and remoteTotalPages if available
      // IMPORTANT: Clear readId if undefined (all reads finished) to force creating new read
      if (userBook && (
        userBook.readId !== config?.hardcoverReadId ||
        userBook.editionId !== config?.hardcoverEditionId ||
        userBook.progress?.started_at !== config?.hardcoverStartedAt ||
        userBook.remoteTotalPages !== config?.hardcoverRemoteTotalPages
      )) {
        const newConfig: any = {
          ...config!,
          hardcoverReadId: userBook.readId, // Will be undefined if all reads finished
          hardcoverEditionId: userBook.editionId,
          hardcoverStartedAt: userBook.progress?.started_at,
          hardcoverRemoteTotalPages: userBook.remoteTotalPages,
        };

        // Remove undefined/null values to actually clear them
        if (newConfig.hardcoverReadId === undefined) {
          delete newConfig.hardcoverReadId;
        }
        if (newConfig.hardcoverEditionId === undefined) {
          delete newConfig.hardcoverEditionId;
        }
        if (newConfig.hardcoverStartedAt === undefined) {
          delete newConfig.hardcoverStartedAt;
        }
        if (newConfig.hardcoverRemoteTotalPages === undefined || newConfig.hardcoverRemoteTotalPages === null) {
          delete newConfig.hardcoverRemoteTotalPages;
        }

        debugLog('[Hardcover] Updating config:', {
          oldReadId: config?.hardcoverReadId,
          newReadId: userBook.readId,
          remoteTotalPages: userBook.remoteTotalPages,
          cleared: userBook.readId === undefined,
        });

        setConfig(bookKey, newConfig);
      }

      if (!userBook || !userBook.progress || !userBook.progress.page) {
        debugLog('[Hardcover] No remote progress found - userBook:', !!userBook, 'progress:', !!userBook?.progress, 'page:', userBook?.progress?.page);
        setSyncState('synced');
        isPulling.current = false;
        return;
      }

      const remoteTimestamp = new Date(userBook.progress.updated_at).getTime();
      const localTimestamp = config?.updatedAt || bookData.book!.updatedAt;
      const remoteIsNewer = remoteTimestamp > localTimestamp;

      const remotePageRaw = userBook.progress.page;

      const isFixedLayout = FIXED_LAYOUT_FORMATS.has(bookData.book!.format);
      const pageInfo = isFixedLayout
        ? progress.section
        : progress.pageinfo;

      const localPage = pageInfo ? pageInfo.current + 1 : 0;
      const localTotalPages = pageInfo?.total || 1;

      // Page mapping for reflowable formats (EPUBs)
      // Remote page is in remote edition's pagination, convert to local pagination
      let remotePage = remotePageRaw;
      let remotePercentage: number;
      let localPercentage = localTotalPages > 0 ? localPage / localTotalPages : 0;

      if (!isFixedLayout) {
        const remoteTotal = userBook.remoteTotalPages;

        if (remoteTotal && remoteTotal !== localTotalPages) {
          // Different pagination - convert from remote to local
          // Step 1: Calculate percentage in remote pagination
          remotePercentage = remotePageRaw / remoteTotal;
          // Step 2: Convert percentage to local page number
          remotePage = Math.round(remotePercentage * localTotalPages);

          debugLog('[Hardcover] Mapping from remote pagination to local:', {
            remotePageRaw,
            remoteTotal,
            localTotalPages,
            remotePercentage: Math.round(remotePercentage * 100) + '%',
            mappedLocalPage: remotePage,
          });
        } else {
          // No remote total or same pagination - use raw page
          remotePercentage = remotePageRaw / localTotalPages;
          remotePage = remotePageRaw;

          if (!remoteTotal) {
            debugLog('[Hardcover] No remote total pages, assuming same scale:', {
              remotePageRaw,
              localTotalPages,
            });
          }
        }
      } else {
        // Fixed layout - pages are absolute
        remotePercentage = localTotalPages > 0 ? remotePage / localTotalPages : 0;
      }

      debugLog('[Hardcover] Pull progress comparison:', {
        remotePage,
        localPage,
        remotePercentage: Math.round(remotePercentage * 100) + '%',
        localPercentage: Math.round(localPercentage * 100) + '%',
        remoteIsNewer,
        strategy,
      });

      // Check for conflict (>5% difference)
      const percentageDiff = Math.abs(remotePercentage - localPercentage);

      if (strategy === 'receive' || (strategy === 'silent' && remoteIsNewer)) {
        // Apply remote progress (use mapped page for EPUBs)
        debugLog('[Hardcover] Applying remote progress from strategy:', strategy);
        applyRemoteProgress(remotePage);
        setSyncState('synced');

        // Wait for navigation to complete before allowing pushes
        setTimeout(() => {
          isPulling.current = false;
        }, 500);
      } else if (strategy === 'prompt' && percentageDiff > 0.05) {
        // Show conflict dialog
        debugLog('[Hardcover] Conflict detected, showing dialog');
        showConflictDialog(
          bookData.book!,
          localPercentage,
          localPage,
          remotePercentage,
          remotePage,
          userBook.progress.updated_at,
          isFixedLayout,
          localTotalPages,
          remotePageRaw,
        );
        setSyncState('conflict');
        // DON'T set isPulling to false - keep blocking pushes until conflict is resolved
      } else {
        debugLog('[Hardcover] No sync needed, difference:', Math.round(percentageDiff * 100) + '%');
        setSyncState('synced');
        isPulling.current = false;
      }
    } catch (error) {
      console.error('Hardcover pull progress failed:', error);
      const errorMessage = (error as Error).message;

      // Handle circuit breaker being open
      if (errorMessage.includes('HARDCOVER_CIRCUIT_OPEN')) {
        console.warn('[Hardcover] Pull blocked by circuit breaker');
        setSyncState('error');
        isPulling.current = false;
        return;
      }

      // Silent fail for network errors to not disrupt reading
      if (!errorMessage.includes('NETWORK')) {
        eventDispatcher.dispatch('toast', {
          message: _('Failed to sync progress from Hardcover'),
          type: 'warning',
        });
      }

      setSyncState('error');
      isPulling.current = false;
    }
  }, [
    bookKey,
    progress,
    appService,
    hardcoverClient,
    settings,
    config,
    matchBook,
    getBookData,
    applyRemoteProgress,
    showConflictDialog,
    _,
  ]);

  /**
   * Push progress to Hardcover (internal async function)
   */
  const pushProgressInternal = useCallback(async () => {
        // Check if circuit breaker is open - if so, silently skip (unless timeout has elapsed)
        const circuitState = getHardcoverCircuitState();
        if (circuitState.state === 'OPEN') {
          const now = Date.now();
          const timeElapsed = now - circuitState.lastFailureTime;
          const CIRCUIT_BREAKER_TIMEOUT = 60000; // 1 minute

          // If timeout hasn't elapsed yet, skip the sync
          if (timeElapsed < CIRCUIT_BREAKER_TIMEOUT) {
            debugLog('[Hardcover] Circuit breaker is open, silently skipping sync');
            return;
          }

          // Timeout has elapsed - allow request to go through so circuit breaker can test recovery
          debugLog('[Hardcover] Circuit breaker timeout elapsed, attempting recovery...');
        }

        const { settings } = useSettingsStore.getState();
        const isSessionMode = settings.hardcover.syncFrequency === 'session';

        if (isSessionMode) {
          console.log('[Hardcover] pushProgress (debounced) executing in SESSION mode');
        } else {
          debugLog('[Hardcover] pushProgress (debounced) executing');
        }

        if (!bookKey || !appService || !hardcoverClient) {
          console.log('[Hardcover] pushProgress early return - missing deps:', {
            bookKey: !!bookKey,
            appService: !!appService,
            hardcoverClient: !!hardcoverClient,
          });
          return;
        }

        // Don't push if we're pulling or there's an unresolved conflict
        if (isPulling.current) {
          console.log('[Hardcover] pushProgress skipped - currently pulling from remote');
          return;
        }

        const currentConflictDetails = conflictDetails;
        if (syncState === 'conflict' || currentConflictDetails) {
          console.log('[Hardcover] pushProgress skipped - conflict pending resolution', {
            syncState,
            hasConflictDetails: !!currentConflictDetails,
          });
          return;
        }

        const { settings: currentSettings } = useSettingsStore.getState();
        const { enabled, syncProgress, strategy } = currentSettings.hardcover;

        if (isSessionMode) {
          console.log('[Hardcover] pushProgress settings (SESSION):', { enabled, syncProgress, strategy });
        } else {
          debugLog('[Hardcover] pushProgress settings:', { enabled, syncProgress, strategy });
        }

        if (!enabled || !syncProgress || strategy === 'receive') {
          console.log('[Hardcover] pushProgress skipped - settings check failed:', {
            enabled,
            syncProgress,
            strategy,
          });
          return;
        }

        const currentProgress = getProgress(bookKey);
        const currentConfig = getConfig(bookKey);
        const bookData = getBookData(bookKey);

        if (!currentProgress || !bookData) {
          debugLog('[Hardcover] pushProgress skipped - no progress or book data');
          return;
        }

        // Ensure book is matched
        debugLog('[Hardcover] Current hardcoverId:', currentConfig?.hardcoverId);
        const hardcoverId = currentConfig?.hardcoverId || (await matchBook());
        debugLog('[Hardcover] Using hardcoverId:', hardcoverId);
        if (!hardcoverId) {
          debugLog('[Hardcover] pushProgress skipped - no hardcoverId');
          return;
        }

        const isFixedLayout = FIXED_LAYOUT_FORMATS.has(bookData.book!.format);
        const pageInfo = isFixedLayout
          ? currentProgress.section
          : currentProgress.pageinfo;

        if (!pageInfo) return;

        const localPage = pageInfo.current + 1;
        const localTotalPages = pageInfo.total;
        const percentage = localTotalPages > 0 ? localPage / localTotalPages : 0;

        // Page mapping for reflowable formats (EPUBs)
        // Different readers paginate EPUBs differently, so we need to convert
        // We use the remote book's total pages as the common reference
        let pageToSend = localPage;

        if (!isFixedLayout) {
          const remoteTotal = currentConfig?.hardcoverRemoteTotalPages;

          if (remoteTotal && remoteTotal !== localTotalPages) {
            // Pagination differs - convert to remote pagination
            // Step 1: Calculate percentage in local pagination
            const percentage = localPage / localTotalPages;
            // Step 2: Convert to page in remote pagination
            pageToSend = Math.round(percentage * remoteTotal);
            debugLog('[Hardcover] Mapping to remote pagination:', {
              localPage,
              localTotalPages,
              remoteTotal,
              percentage: Math.round(percentage * 100) + '%',
              mappedRemotePage: pageToSend,
            });
          } else {
            // No remote total or same pagination - send raw page
            pageToSend = localPage;
            if (!remoteTotal) {
              debugLog('[Hardcover] No remote total pages yet, using local page:', localPage);
            }
          }
        }

        debugLog('[Hardcover] Sending progress update:', {
          hardcoverId,
          page: pageToSend,
          percentage,
          readId: currentConfig?.hardcoverReadId,
          editionId: currentConfig?.hardcoverEditionId,
          startedAt: currentConfig?.hardcoverStartedAt,
          keepalive: isSessionMode,
        });

        try {
          const result = await hardcoverClient.updateProgress(
            hardcoverId,
            pageToSend,
            percentage,
            currentConfig?.hardcoverReadId,
            currentConfig?.hardcoverEditionId,
            currentConfig?.hardcoverStartedAt,
            isSessionMode, // keepalive: true for session mode to survive page navigation
          );

          debugLog('[Hardcover] Progress update result:', result);

          if (result.success) {
            // Update config with returned data (including readId for future updates)
            setConfig(bookKey, {
              ...currentConfig!,
              hardcoverReadId: result.readId || currentConfig?.hardcoverReadId,
              hardcoverEditionId: result.editionId || currentConfig?.hardcoverEditionId,
              hardcoverStartedAt: result.startedAt || currentConfig?.hardcoverStartedAt,
              hardcoverLastSynced: Date.now(),
            });
            setSyncState('synced');
            debugLog('[Hardcover] Progress synced successfully, readId:', result.readId);

            // Check if circuit breaker just recovered
            const wasRecovered = checkAndClearHardcoverRecovery();
            if (wasRecovered) {
              eventDispatcher.dispatch('toast', {
                message: _('Hardcover sync restored'),
                type: 'success',
              });
            }
          } else {
            setSyncState('error');
            console.error('[Hardcover] Progress sync failed');

            // Get circuit breaker state for notifications
            const circuitState = getHardcoverCircuitState();

            // Notification logic: 1st failure = notify, 2nd = silent, 3rd = notify circuit open
            if (circuitState.failureCount === 1) {
              eventDispatcher.dispatch('toast', {
                message: _('Failed to sync progress to Hardcover'),
                type: 'error',
              });
            } else if (circuitState.failureCount === 3 && circuitState.state === 'OPEN' && !circuitState.hasNotifiedDisconnect) {
              eventDispatcher.dispatch('toast', {
                message: _('Hardcover sync temporarily disabled. Will retry in 60 seconds.'),
                type: 'error',
              });
              markHardcoverDisconnectNotified();
            }
            // failureCount === 2 or already notified: silent
          }
        } catch (error) {
          const errorMessage = (error as Error).message;

          // Handle circuit breaker being open
          if (errorMessage.includes('HARDCOVER_CIRCUIT_OPEN')) {
            console.warn('[Hardcover] Circuit breaker is open, skipping sync');
            setSyncState('error');
            // Don't show toast for every blocked request - user already knows service is down
            return;
          }

          // If the stored hardcoverId is invalid (book doesn't exist in user's library), clear it
          if (errorMessage.includes('HARDCOVER_INVALID_USER_BOOK')) {
            console.warn('[Hardcover] Invalid user_book ID detected, clearing stored data');
            setConfig(bookKey, {
              ...currentConfig!,
              hardcoverId: undefined,
              hardcoverReadId: undefined,
              hardcoverEditionId: undefined,
              hardcoverStartedAt: undefined,
            });
            setNeedsMatching(true);
            setSyncState('error');
            eventDispatcher.dispatch('toast', {
              message: _('Hardcover book link is invalid. Please re-match the book.'),
              type: 'warning',
            });
          } else {
            setSyncState('error');
            console.error('[Hardcover] Progress sync error:', error);

            // Get circuit breaker state for notifications
            const circuitState = getHardcoverCircuitState();

            // Notification logic: 1st failure = notify, 2nd = silent, 3rd = notify circuit open
            if (circuitState.failureCount === 1) {
              eventDispatcher.dispatch('toast', {
                message: _('Failed to sync progress to Hardcover'),
                type: 'error',
              });
            } else if (circuitState.failureCount === 3 && circuitState.state === 'OPEN' && !circuitState.hasNotifiedDisconnect) {
              eventDispatcher.dispatch('toast', {
                message: _('Hardcover sync temporarily disabled. Will retry in 60 seconds.'),
                type: 'error',
              });
              markHardcoverDisconnectNotified();
            }
            // failureCount === 2 or already notified: silent
          }
        }
  }, [bookKey, appService, hardcoverClient, matchBook, getProgress, getConfig, getBookData, setConfig, syncState, conflictDetails, _]);

  /**
   * Debounced wrapper for pushProgressInternal
   */
  const pushProgress = useMemo(
    () => debounce(pushProgressInternal, 5000),
    [pushProgressInternal],
  );

  // Event listeners for manual push/pull
  useEffect(() => {
    const handlePushProgress = (event: CustomEvent) => {
      if (event.detail.bookKey !== bookKey) return;
      pushProgress();
      pushProgress.flush();
    };
    const handleFlush = (event: CustomEvent) => {
      if (event.detail.bookKey !== bookKey) return;
      console.log('[Hardcover] Flush event received, mode:', settings.hardcover.syncFrequency);

      // For session mode, force an immediate sync on close
      if (settings.hardcover.syncFrequency === 'session') {
        console.log('[Hardcover] Session mode - forcing sync on book close');

        // Create and store the sync promise
        const syncPromise = (async () => {
          try {
            // Call the internal function directly (not debounced) and await it
            await pushProgressInternal();
            console.log('[Hardcover] Session mode sync completed successfully');

            eventDispatcher.dispatch('toast', {
              message: _('Synced to Hardcover'),
              type: 'success',
            });
          } catch (error) {
            console.error('[Hardcover] Session mode sync failed:', error);
            eventDispatcher.dispatch('toast', {
              message: _('Failed to sync to Hardcover'),
              type: 'error',
            });
          } finally {
            // Clear the promise ref and remove from registry
            activeSyncPromise.current = null;
            activeSyncPromises.delete(bookKey);
          }
        })();

        activeSyncPromise.current = syncPromise;
        // Register in module-level map so ReaderContent can wait for it
        activeSyncPromises.set(bookKey, syncPromise);
      } else {
        // For other modes, just flush any pending calls
        debugLog('[Hardcover] Flushing pending sync');
        pushProgress.flush();
      }
    };
    eventDispatcher.on('push-hardcover', handlePushProgress);
    eventDispatcher.on('flush-hardcover', handleFlush);
    return () => {
      eventDispatcher.off('push-hardcover', handlePushProgress);
      eventDispatcher.off('flush-hardcover', handleFlush);
      // Always flush on unmount
      pushProgress.flush();
    };
  }, [bookKey, pushProgress, settings.hardcover.syncFrequency, debugLog]);

  // Event listener for manual pull
  useEffect(() => {
    const handlePullProgress = (event: CustomEvent) => {
      if (event.detail.bookKey !== bookKey) return;
      pullProgress();
    };
    eventDispatcher.on('pull-hardcover', handlePullProgress);
    return () => {
      eventDispatcher.off('pull-hardcover', handlePullProgress);
    };
  }, [bookKey, pullProgress]);

  // Pull once when book opens
  useEffect(() => {
    if (!appService || !hardcoverClient || !progress?.location) return;
    if (hasPulledOnce.current) return;
    pullProgress();
  }, [appService, hardcoverClient, progress?.location, pullProgress]);

  // Auto-push on progress change
  useEffect(() => {
    debugLog('[Hardcover] Auto-push effect triggered', {
      hasProgress: !!progress,
      hasClient: !!hardcoverClient,
      enabled: settings.hardcover.enabled,
      syncProgress: settings.hardcover.syncProgress,
      syncFrequency: settings.hardcover.syncFrequency,
      strategy: settings.hardcover.strategy,
      hardcoverId: config?.hardcoverId,
      syncState,
      hasConflict: !!conflictDetails,
      isPulling: isPulling.current,
    });

    // Don't auto-push if we're pulling
    if (isPulling.current) {
      debugLog('[Hardcover] Auto-push skipped - currently pulling from remote');
      return;
    }

    // Don't auto-push if there's an unresolved conflict (check both state and conflictDetails)
    if (syncState === 'conflict' || conflictDetails) {
      debugLog('[Hardcover] Auto-push skipped - conflict pending resolution');
      return;
    }

    if (progress && hardcoverClient) {
      const { strategy, enabled, syncProgress, syncFrequency } = settings.hardcover;

      // Skip auto-push for 'session' mode (only sync on open/close)
      if (syncFrequency === 'session') {
        debugLog('[Hardcover] Auto-push skipped - session mode (sync on open/close only)');
        return;
      }

      // For 'chapter' mode, only push when section changes
      if (syncFrequency === 'chapter') {
        const currentSection = progress.sectionHref;
        if (currentSection === lastSyncedSection.current) {
          debugLog('[Hardcover] Auto-push skipped - chapter mode and section unchanged');
          return;
        }
        debugLog('[Hardcover] Chapter changed, syncing:', {
          previous: lastSyncedSection.current,
          current: currentSection,
        });
        lastSyncedSection.current = currentSection;
      }

      if (strategy !== 'receive' && enabled && syncProgress) {
        debugLog('[Hardcover] Triggering pushProgress');
        pushProgress();
      }
    }
  }, [progress, hardcoverClient, settings.hardcover, pushProgress, config?.hardcoverId, syncState, conflictDetails]);

  // Set "Currently Reading" status when book is first opened
  useEffect(() => {
    debugLog('[Hardcover] Status sync effect (Currently Reading)', {
      hasClient: !!hardcoverClient,
      hardcoverId: config?.hardcoverId,
      alreadySet: hasSetCurrentlyReading.current,
      syncStatus: settings.hardcover.syncStatus,
    });

    if (!hardcoverClient || !config?.hardcoverId || hasSetCurrentlyReading.current) return;

    const setCurrentlyReading = async () => {
      debugLog('[Hardcover] Setting status to CURRENTLY_READING');
      hasSetCurrentlyReading.current = true;
      await syncStatus('CURRENTLY_READING');
    };

    setCurrentlyReading();
  }, [hardcoverClient, config?.hardcoverId, syncStatus, settings.hardcover.syncStatus]);

  // Set "Read" status when book reaches 100%
  useEffect(() => {
    if (!progress || !hardcoverClient || !config?.hardcoverId) return;

    const bookData = getBookData(bookKey);
    if (!bookData?.book?.format) return;

    const pageInfo = FIXED_LAYOUT_FORMATS.has(bookData.book.format)
      ? progress.section
      : progress.pageinfo;

    if (!pageInfo) return;

    const percentage = pageInfo.total > 0 ? (pageInfo.current + 1) / pageInfo.total : 0;

    // Check if just reached 100% (to avoid multiple calls)
    if (percentage >= 1.0 && lastPercentage.current < 1.0) {
      syncStatus('READ');
    }

    lastPercentage.current = percentage;
  }, [progress, hardcoverClient, config?.hardcoverId, bookKey, getBookData, syncStatus]);

  const resolveWithLocal = useCallback(() => {
    isPulling.current = false; // Allow pushes now that conflict is resolved
    pushProgress();
    pushProgress.flush();
    setSyncState('synced');
    setConflictDetails(null);
  }, [pushProgress]);

  const resolveWithRemote = useCallback(() => {
    if (!conflictDetails) return;
    // Use page number directly, not percentage
    const remotePage = conflictDetails.conflict.remote.page || 0;
    applyRemoteProgress(remotePage);
    setSyncState('synced');
    setConflictDetails(null);

    // Wait for navigation to complete before allowing pushes (500ms should be enough)
    setTimeout(() => {
      isPulling.current = false;
    }, 500);
  }, [conflictDetails, applyRemoteProgress]);

  /**
   * Force an immediate sync (for session mode on book close)
   * This is called directly (not through events) to ensure proper awaiting
   */
  const forceSync = useCallback(async () => {
    // Check if circuit breaker is open - if so, silently skip (unless timeout has elapsed)
    const circuitState = getHardcoverCircuitState();
    if (circuitState.state === 'OPEN') {
      const now = Date.now();
      const timeElapsed = now - circuitState.lastFailureTime;
      const CIRCUIT_BREAKER_TIMEOUT = 60000; // 1 minute

      // If timeout hasn't elapsed yet, skip the sync
      if (timeElapsed < CIRCUIT_BREAKER_TIMEOUT) {
        debugLog('[Hardcover] forceSync - circuit breaker is open, silently skipping');
        return;
      }

      // Timeout has elapsed - allow request to go through so circuit breaker can test recovery
      console.log('[Hardcover] forceSync - circuit breaker timeout elapsed, attempting recovery...');
    }

    const { syncFrequency } = useSettingsStore.getState().settings.hardcover;
    if (syncFrequency !== 'session') {
      // For non-session modes, just flush the debounced function
      pushProgress.flush();
      return;
    }

    // For session mode, do immediate sync
    console.log('[Hardcover] forceSync called - executing immediate sync');
    try {
      await pushProgressInternal();
      console.log('[Hardcover] forceSync completed successfully');

      // Check if circuit breaker just recovered - only show toast for recovery
      const wasRecovered = checkAndClearHardcoverRecovery();
      if (wasRecovered) {
        eventDispatcher.dispatch('toast', {
          message: _('Hardcover sync restored'),
          type: 'success',
        });
      }
    } catch (error) {
      const errorMessage = (error as Error).message;

      // Handle circuit breaker being open silently (shouldn't happen due to check above)
      if (errorMessage.includes('HARDCOVER_CIRCUIT_OPEN')) {
        console.warn('[Hardcover] forceSync blocked by circuit breaker');
        return;
      }

      console.error('[Hardcover] forceSync failed:', error);

      // Get circuit breaker state for notifications
      const circuitStateAfterError = getHardcoverCircuitState();

      // Notification logic: 1st failure = notify, 2nd = silent, 3rd = notify circuit open
      if (circuitStateAfterError.failureCount === 1) {
        eventDispatcher.dispatch('toast', {
          message: _('Failed to sync to Hardcover'),
          type: 'error',
        });
      } else if (circuitStateAfterError.failureCount === 3 && circuitStateAfterError.state === 'OPEN' && !circuitStateAfterError.hasNotifiedDisconnect) {
        eventDispatcher.dispatch('toast', {
          message: _('Hardcover sync temporarily disabled. Will retry in 60 seconds.'),
          type: 'error',
        });
        markHardcoverDisconnectNotified();
      }
      // failureCount === 2 or already notified: silent
    }
  }, [pushProgress, pushProgressInternal, _]);

  // Register forceSync function in module registry
  useEffect(() => {
    forceSyncFunctions.set(bookKey, forceSync);
    return () => {
      forceSyncFunctions.delete(bookKey);
    };
  }, [bookKey, forceSync]);

  return {
    syncState,
    conflictDetails,
    needsMatching,
    hardcoverClient,
    pushProgress,
    pullProgress,
    resolveWithLocal,
    resolveWithRemote,
    setNeedsMatching,
    forceSync,
  };
};
