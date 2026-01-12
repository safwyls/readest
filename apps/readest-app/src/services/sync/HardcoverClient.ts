import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '../environment';
import { HardcoverSettings } from '@/types/settings';
import { Book } from '@/types/book';
import {
  HardcoverBook,
  HardcoverUserBook,
  HardcoverReadingStatus,
  HARDCOVER_STATUS_MAP,
} from './hardcoverTypes';
import {
  GET_ME_QUERY,
  SEARCH_BOOKS_QUERY,
  HYDRATE_BOOKS_QUERY,
  GET_USER_BOOK_QUERY,
  CREATE_READ_MUTATION,
  UPDATE_PROGRESS_MUTATION,
  CREATE_USER_BOOK_MUTATION,
  UPDATE_STATUS_MUTATION,
  DELETE_READ_MUTATION,
  GET_ALL_READS_QUERY,
} from './hardcoverQueries';

const HARDCOVER_API_URL = 'https://api.hardcover.app/v1/graphql';
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 60;

// Circuit breaker configuration
const CIRCUIT_BREAKER_THRESHOLD = 3; // Open circuit after 3 consecutive failures
const CIRCUIT_BREAKER_TIMEOUT = 60000; // Try again after 1 minute
const CIRCUIT_BREAKER_HALF_OPEN_REQUESTS = 1; // Allow 1 request in half-open state

enum CircuitState {
  CLOSED = 'CLOSED', // Normal operation
  OPEN = 'OPEN', // Failing, reject requests immediately
  HALF_OPEN = 'HALF_OPEN', // Testing if service recovered
}

// Global circuit breaker state (shared across all client instances)
class CircuitBreakerState {
  private static instance: CircuitBreakerState;

  state: CircuitState = CircuitState.CLOSED;
  failureCount: number = 0;
  lastFailureTime: number = 0;
  halfOpenAttempts: number = 0;
  hasNotifiedDisconnect: boolean = false; // Track if we've shown disconnect toast

  private constructor() {}

  static getInstance(): CircuitBreakerState {
    if (!CircuitBreakerState.instance) {
      CircuitBreakerState.instance = new CircuitBreakerState();
    }
    return CircuitBreakerState.instance;
  }

  reset() {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.halfOpenAttempts = 0;
    this.hasNotifiedDisconnect = false;
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      hasNotifiedDisconnect: this.hasNotifiedDisconnect,
    };
  }

  checkAndClearRecoveryFlag(): boolean {
    if (this.lastFailureTime === -1) {
      this.lastFailureTime = 0; // Clear the flag
      this.hasNotifiedDisconnect = false; // Clear disconnect notification flag on recovery
      return true; // Was just recovered
    }
    return false; // Not a recovery
  }

  markDisconnectNotified() {
    this.hasNotifiedDisconnect = true;
  }
}

// Export function to get circuit breaker state from anywhere
export const getHardcoverCircuitState = () => {
  return CircuitBreakerState.getInstance().getState();
};

// Export function to check and clear recovery flag
export const checkAndClearHardcoverRecovery = () => {
  return CircuitBreakerState.getInstance().checkAndClearRecoveryFlag();
};

// Export function to mark that we've notified user of disconnect
export const markHardcoverDisconnectNotified = () => {
  CircuitBreakerState.getInstance().markDisconnectNotified();
};

// Export function to manually reset circuit breaker
export const resetHardcoverCircuitBreaker = () => {
  console.log('[Circuit Breaker] Manual reset triggered');
  CircuitBreakerState.getInstance().reset();
};

export class HardcoverClient {
  private config: HardcoverSettings;
  private requestTimestamps: number[] = [];
  private userId: number | null = null;
  private circuitBreaker = CircuitBreakerState.getInstance();

  constructor(config: HardcoverSettings) {
    this.config = config;
  }

  /**
   * Debug logging helper
   */
  private debugLog(...args: any[]) {
    if (this.config.debug) {
      console.log(...args);
    }
  }

  /**
   * Get current circuit breaker state (for user feedback)
   */
  getCircuitState() {
    return {
      state: this.circuitBreaker.state,
      failureCount: this.circuitBreaker.failureCount,
      lastFailureTime: this.circuitBreaker.lastFailureTime,
    };
  }

  /**
   * Check if circuit breaker allows the request
   */
  private canMakeRequest(): { allowed: boolean; reason?: string } {
    const now = Date.now();

    switch (this.circuitBreaker.state) {
      case CircuitState.CLOSED:
        // Normal operation
        return { allowed: true };

      case CircuitState.OPEN:
        // Check if timeout has elapsed
        if (now - this.circuitBreaker.lastFailureTime >= CIRCUIT_BREAKER_TIMEOUT) {
          console.log('[Circuit Breaker] ⏰ Timeout elapsed, transitioning to HALF_OPEN');
          this.circuitBreaker.state = CircuitState.HALF_OPEN;
          this.circuitBreaker.halfOpenAttempts = 0;
          return { allowed: true };
        }
        // Circuit still open
        const waitTime = Math.ceil((CIRCUIT_BREAKER_TIMEOUT - (now - this.circuitBreaker.lastFailureTime)) / 1000);
        return {
          allowed: false,
          reason: `Circuit breaker is open. Hardcover service unavailable. Retry in ${waitTime}s.`,
        };

      case CircuitState.HALF_OPEN:
        // Allow limited requests to test service
        if (this.circuitBreaker.halfOpenAttempts < CIRCUIT_BREAKER_HALF_OPEN_REQUESTS) {
          this.circuitBreaker.halfOpenAttempts++;
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: 'Circuit breaker is testing service recovery. Please wait.',
        };
    }
  }

  /**
   * Record a successful request
   */
  private recordSuccess() {
    const wasHalfOpen = this.circuitBreaker.state === CircuitState.HALF_OPEN;
    if (wasHalfOpen) {
      console.log('[Circuit Breaker] ✅ Request succeeded in HALF_OPEN, transitioning to CLOSED');
      this.circuitBreaker.state = CircuitState.CLOSED;
      // Set a flag so the hook can show a recovery toast
      this.circuitBreaker.lastFailureTime = -1; // Use -1 as a signal that we just recovered
    }
    this.circuitBreaker.failureCount = 0;
  }

  /**
   * Record a failed request
   */
  private recordFailure(error: string) {
    this.circuitBreaker.failureCount++;
    this.circuitBreaker.lastFailureTime = Date.now();

    // Don't open circuit for auth failures (user needs to fix token)
    if (error.includes('AUTH_FAILED')) {
      console.log('[Circuit Breaker] Auth failure, not counting towards circuit breaker');
      return;
    }

    if (this.circuitBreaker.state === CircuitState.HALF_OPEN) {
      console.warn('[Circuit Breaker] ❌ Request failed in HALF_OPEN, transitioning to OPEN');
      this.circuitBreaker.state = CircuitState.OPEN;
      this.circuitBreaker.failureCount = CIRCUIT_BREAKER_THRESHOLD; // Ensure we stay open
      return;
    }

    if (this.circuitBreaker.failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
      console.warn(
        `[Circuit Breaker] ⚠️ OPENED after ${this.circuitBreaker.failureCount} consecutive failures. Will retry in 60s.`,
      );
      this.circuitBreaker.state = CircuitState.OPEN;
    } else {
      console.log(
        `[Circuit Breaker] Failure ${this.circuitBreaker.failureCount}/${CIRCUIT_BREAKER_THRESHOLD}`,
      );
    }
  }

  async getUserId(): Promise<number | null> {
    if (this.userId) return this.userId;

    try {
      const data = await this.graphqlRequest<{ me: Array<{ id: number }> }>(GET_ME_QUERY);
      if (data.me && data.me.length > 0) {
        this.userId = data.me[0].id;
        return this.userId;
      }
    } catch (error) {
      console.error('[Hardcover] Failed to get user ID:', error);
    }
    return null;
  }

  /**
   * Rate limiting check - ensures we don't exceed 60 req/min
   */
  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    // Remove timestamps older than 1 minute
    this.requestTimestamps = this.requestTimestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW);

    const buffer = this.config.rateLimitBuffer || 50;
    if (this.requestTimestamps.length >= buffer) {
      const oldestRequest = this.requestTimestamps[0]!;
      const waitTime = RATE_LIMIT_WINDOW - (now - oldestRequest) + 100;
      if (waitTime > 0) {
        this.debugLog(`Hardcover rate limit approaching, waiting ${waitTime}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    this.requestTimestamps.push(now);
  }

  /**
   * GraphQL request wrapper with auth and error handling
   */
  private async graphqlRequest<T>(
    query: string,
    variables: Record<string, unknown> = {},
    options: { keepalive?: boolean } = {},
  ): Promise<T> {
    // Check circuit breaker first
    const { allowed, reason } = this.canMakeRequest();
    if (!allowed) {
      console.warn('[Circuit Breaker] 🚫 Request blocked:', reason);
      throw new Error(`HARDCOVER_CIRCUIT_OPEN: ${reason}`);
    }

    if (!this.config.apiToken || this.config.apiToken.trim() === '') {
      throw new Error('HARDCOVER_AUTH_FAILED');
    }

    await this.checkRateLimit();

    const headers = {
      'Content-Type': 'application/json',
      authorization: this.config.apiToken,
    };

    const body = JSON.stringify({ query, variables });

    const fetchFn = isTauriAppPlatform() ? tauriFetch : window.fetch;

    try {
      const response = await fetchFn(HARDCOVER_API_URL, {
        method: 'POST',
        headers,
        body,
        keepalive: options.keepalive || false,
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('HARDCOVER_AUTH_FAILED');
        }
        if (response.status === 429) {
          throw new Error('HARDCOVER_RATE_LIMIT');
        }
        if (response.status >= 500) {
          throw new Error('HARDCOVER_SERVER_ERROR');
        }
        throw new Error(`HARDCOVER_API_ERROR_${response.status}`);
      }

      const json = await response.json();

      if (json.errors) {
        const errorMsg = json.errors[0]?.message || 'Unknown error';
        console.error('Hardcover GraphQL error:', errorMsg);

        // Handle specific GraphQL error codes
        if (errorMsg.includes('403') || errorMsg.includes('Forbidden')) {
          const authError = new Error('HARDCOVER_AUTH_FAILED');
          this.recordFailure(authError.message);
          throw authError;
        }
        if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) {
          const authError = new Error('HARDCOVER_AUTH_FAILED');
          this.recordFailure(authError.message);
          throw authError;
        }
        if (errorMsg.includes('429') || errorMsg.includes('rate limit')) {
          const rateLimitError = new Error('HARDCOVER_RATE_LIMIT');
          this.recordFailure(rateLimitError.message);
          throw rateLimitError;
        }

        const graphqlError = new Error(`HARDCOVER_GRAPHQL_ERROR: ${errorMsg}`);
        this.recordFailure(graphqlError.message);
        throw graphqlError;
      }

      // Success - record it
      this.recordSuccess();
      return json.data as T;
    } catch (error) {
      if (error instanceof Error) {
        // If error was already thrown above (with recordFailure called), re-throw it
        if (error.message.startsWith('HARDCOVER_')) {
          throw error;
        }

        // Network errors
        if (error.message.includes('fetch') || error.message.includes('network')) {
          const networkError = new Error('HARDCOVER_NETWORK_ERROR');
          this.recordFailure(networkError.message);
          throw networkError;
        }

        // Other errors
        this.recordFailure(error.message);
        throw error;
      }
      console.error('Hardcover GraphQL request failed:', error);
      const unknownError = new Error('HARDCOVER_UNKNOWN_ERROR');
      this.recordFailure(unknownError.message);
      throw unknownError;
    }
  }

  /**
   * Test connection and validate API token
   */
  async testConnection(): Promise<{ success: boolean; message?: string }> {
    try {
      await this.graphqlRequest('{ __typename }');
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('HARDCOVER_AUTH_FAILED')) {
        return { success: false, message: 'Invalid API token' };
      }
      return { success: false, message: message || 'Connection failed' };
    }
  }

  /**
   * Search for books by title/author
   */
  async searchBooks(title: string, author?: string): Promise<HardcoverBook[]> {
    const query = author ? `${title} ${author}` : title;

    const data = await this.graphqlRequest<{ search: { results: any } }>(SEARCH_BOOKS_QUERY, {
      query,
      perPage: 10,
    });

    if (!data.search || !data.search.results) {
      return [];
    }

    // Hardcover returns results.hits[] with document inside each hit
    const hits = data.search.results.hits;
    if (!Array.isArray(hits) || hits.length === 0) {
      this.debugLog('[Hardcover] No results found for query:', query);
      return [];
    }

    this.debugLog(`[Hardcover] Found ${hits.length} results for query:`, query);

    // Parse the results - extract document from each hit
    return hits.map((hit: any) => {
      const doc = hit.document;
      // Extract ISBNs from the isbns array
      const isbns = doc.isbns || [];
      const isbn_13 = isbns.find((isbn: string) => isbn.length === 13) || '';
      const isbn_10 = isbns.find((isbn: string) => isbn.length === 10) || '';

      return {
        id: doc.id?.toString() || '',
        title: doc.title || '',
        subtitle: doc.subtitle || '',
        authors: doc.contributions
          ? doc.contributions
              .filter((c: any) => c.author)
              .map((c: any) => ({ name: c.author.name || '' }))
          : [],
        isbn_10,
        isbn_13,
        image_url: doc.image?.url || '',
      };
    });
  }

  /**
   * Get user's book data (progress and status)
   * @param userBookId The user_book.id (stored as hardcoverId)
   */
  async getUserBook(userBookId: string): Promise<HardcoverUserBook | null> {
    try {
      const data = await this.graphqlRequest<{ user_books: any[] }>(GET_USER_BOOK_QUERY, {
        userBookId: parseInt(userBookId, 10),
      });

      if (!data.user_books || data.user_books.length === 0) {
        return null;
      }

      const userBook = data.user_books[0];
      this.debugLog('[Hardcover] getUserBook raw response:', JSON.stringify(userBook, null, 2));

      // Get most recent read for progress
      const reads = userBook.user_book_reads || [];
      this.debugLog('[Hardcover] Total reads found:', reads.length);
      this.debugLog('[Hardcover] All reads:', JSON.stringify(reads, null, 2));

      // Find the active read (no finished_at)
      // IMPORTANT: Only use active reads - finished reads cannot be updated
      const activeRead = reads.find((r: any) => !r.finished_at);

      this.debugLog('[Hardcover] Active read:', activeRead);
      this.debugLog('[Hardcover] All reads finished?', reads.length > 0 && !activeRead);

      // If no active read, don't use finished reads - they can't be updated
      const latestRead = activeRead || null;

      this.debugLog('[Hardcover] Selected read:', latestRead);
      this.debugLog('[Hardcover] Progress pages:', latestRead?.progress_pages);

      // Extract total page count from edition or book
      // Prefer edition pages (specific to the edition the user has)
      const remoteTotalPages = userBook.edition?.pages || userBook.book?.pages || null;
      this.debugLog('[Hardcover] Remote total pages:', remoteTotalPages, {
        editionPages: userBook.edition?.pages,
        bookPages: userBook.book?.pages,
      });

      const result = {
        id: userBook.id,
        book: {
          id: userBook.book_id?.toString() || userBookId.toString(),
          title: '',
        },
        status: {
          status_id: userBook.status_id,
          status: this.getStatusName(userBook.status_id),
        },
        progress: latestRead
          ? {
              page: latestRead.progress_pages,
              percentage: 0, // Not used by Hardcover
              updated_at: latestRead.started_at,
              edition_id: latestRead.edition_id,
              started_at: latestRead.started_at,
            }
          : null,
        readId: latestRead?.id, // Track the read ID for updates
        editionId: userBook.edition_id || latestRead?.edition_id, // Track edition ID
        remoteTotalPages, // Total pages in the remote edition
      };

      this.debugLog('[Hardcover] Parsed getUserBook result:', result);
      return result;
    } catch (error) {
      console.error('Failed to get user book:', error);
      return null;
    }
  }

  private getStatusName(statusId: number): string {
    const statusMap: Record<number, string> = {
      1: 'WANT_TO_READ',
      2: 'CURRENTLY_READING',
      3: 'READ',
      4: 'DNF',
    };
    return statusMap[statusId] || 'UNKNOWN';
  }

  /**
   * Update reading progress
   * Returns the read ID if successful
   */
  async updateProgress(
    userBookId: string,
    page: number,
    percentage: number,
    readId?: number,
    editionId?: number,
    startedAt?: string,
    keepalive?: boolean,
  ): Promise<{ success: boolean; readId?: number; editionId?: number; startedAt?: string }> {
    try {
      this.debugLog('[Hardcover] Updating progress:', { userBookId, page, readId, editionId, startedAt });

      if (readId) {
        // Update existing read - preserve original started_at date
        // Only include startedAt if we have a value, otherwise omit to preserve existing
        const variables: Record<string, any> = {
          readId,
          pages: Math.floor(page),
        };

        if (editionId) {
          variables.editionId = editionId;
        }

        if (startedAt) {
          variables.startedAt = startedAt;
        }

        this.debugLog('[Hardcover] UPDATE mutation variables:', variables);

        const result = await this.graphqlRequest<{
          update_user_book_read: {
            error?: string;
            user_book_read?: {
              id: number;
              progress_pages: number;
              started_at: string;
              edition_id: number;
            };
          }
        }>(
          UPDATE_PROGRESS_MUTATION,
          variables,
          { keepalive },
        );
        this.debugLog('[Hardcover] UPDATE result:', JSON.stringify(result, null, 2));

        if (result.update_user_book_read?.error) {
          console.error('[Hardcover] Update error:', result.update_user_book_read.error);
          // If update failed, maybe the read was deleted - try creating a new one
          this.debugLog('[Hardcover] Falling back to creating new read...');
          return this.updateProgress(userBookId, page, percentage, undefined, editionId, startedAt, keepalive);
        }

        const userBookRead = result.update_user_book_read?.user_book_read;

        if (!userBookRead) {
          console.warn('[Hardcover] Update succeeded but no user_book_read returned');
          return { success: false };
        }

        // Check if progress_pages is null - this means the read is finished and can't be updated
        if (userBookRead.progress_pages === null) {
          console.warn('[Hardcover] Update returned null progress - read is finished, creating new read instead');
          // Recursively call with no readId to create a new read
          return this.updateProgress(userBookId, page, percentage, undefined, editionId, startedAt, keepalive);
        }

        this.debugLog('[Hardcover] Successfully updated read:', {
          id: userBookRead.id,
          progress_pages: userBookRead.progress_pages,
          edition_id: userBookRead.edition_id,
          started_at: userBookRead.started_at,
        });

        return {
          success: true,
          readId: userBookRead.id,
          editionId: userBookRead.edition_id,
          startedAt: userBookRead.started_at,
        };
      } else {
        // Create new read with today's date (or use provided startedAt)
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

        const variables: Record<string, any> = {
          userBookId: parseInt(userBookId, 10),
          pages: Math.floor(page),
          startedAt: startedAt || today, // Use provided date or today
        };

        if (editionId) {
          variables.editionId = editionId;
        }

        this.debugLog('[Hardcover] CREATE mutation variables:', variables);

        const result = await this.graphqlRequest<{
          insert_user_book_read: {
            error?: string;
            user_book_read?: {
              id: number;
              progress_pages: number;
              started_at: string;
              edition_id: number;
            };
          }
        }>(
          CREATE_READ_MUTATION,
          variables,
          { keepalive },
        );
        this.debugLog('[Hardcover] CREATE result:', JSON.stringify(result, null, 2));

        if (result.insert_user_book_read?.error) {
          const error = result.insert_user_book_read.error;
          console.error('[Hardcover] Create error:', error);

          // If the user_book doesn't exist, throw a specific error so the hook can clear the bad ID
          if (error.includes("Couldn't find UserBook")) {
            throw new Error('HARDCOVER_INVALID_USER_BOOK');
          }

          return { success: false };
        }

        const userBookRead = result.insert_user_book_read?.user_book_read;

        if (!userBookRead) {
          console.warn('[Hardcover] Create succeeded but no user_book_read returned');
          return { success: false };
        }

        this.debugLog('[Hardcover] Successfully created read:', {
          id: userBookRead.id,
          progress_pages: userBookRead.progress_pages,
          edition_id: userBookRead.edition_id,
          started_at: userBookRead.started_at,
        });

        return {
          success: true,
          readId: userBookRead.id,
          editionId: userBookRead.edition_id,
          startedAt: userBookRead.started_at,
        };
      }
    } catch (error) {
      console.error('Failed to update progress:', error);
      return { success: false };
    }
  }

  /**
   * Update reading status
   */
  async updateStatus(userBookId: string, status: HardcoverReadingStatus): Promise<boolean> {
    try {
      this.debugLog('[Hardcover] Updating status:', { userBookId, status });
      const result = await this.graphqlRequest<{
        update_user_book: {
          error?: string;
          user_book?: {
            id: number;
            status_id: number;
          }
        }
      }>(
        UPDATE_STATUS_MUTATION,
        {
          userBookId: parseInt(userBookId, 10),
          statusId: HARDCOVER_STATUS_MAP[status],
        },
      );

      this.debugLog('[Hardcover] Status update result:', result);

      // If we have user_book data, consider it successful even if there's an error message
      // (Hardcover sometimes returns warnings as errors)
      if (result.update_user_book?.user_book) {
        return true;
      }

      // Otherwise check for error
      if (result.update_user_book?.error) {
        console.warn('[Hardcover] Status update returned error:', result.update_user_book.error);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Failed to update status:', error);
      return false;
    }
  }

  /**
   * Add book to user's library
   */
  async addBookToLibrary(
    bookId: string,
    status: HardcoverReadingStatus = 'CURRENTLY_READING',
  ): Promise<string | null> {
    try {
      // Get user's privacy setting
      const userData = await this.graphqlRequest<{ me: Array<{ account_privacy_setting_id?: number }> }>(
        GET_ME_QUERY,
      );
      const privacySettingId = userData.me?.[0]?.account_privacy_setting_id || 1;

      const result = await this.graphqlRequest<{
        insert_user_book: { error?: string; user_book?: { id: string } };
      }>(CREATE_USER_BOOK_MUTATION, {
        object: {
          book_id: parseInt(bookId, 10),
          status_id: HARDCOVER_STATUS_MAP[status],
          privacy_setting_id: privacySettingId,
        },
      });

      if (result.insert_user_book?.error) {
        console.error('[Hardcover] Error adding book:', result.insert_user_book.error);
        return null;
      }

      return result.insert_user_book?.user_book?.id || null;
    } catch (error) {
      console.error('Failed to add book to library:', error);
      return null;
    }
  }

  /**
   * Match local book to Hardcover book using ISBN or title/author
   */
  async matchBook(book: Book): Promise<HardcoverBook | null> {
    // Try ISBN first
    if (book.metadata?.isbn) {
      const results = await this.searchBooks(book.metadata.isbn);
      const exactMatch = results.find(
        (hb) => hb.isbn_13 === book.metadata?.isbn || hb.isbn_10 === book.metadata?.isbn,
      );
      if (exactMatch) return exactMatch;
    }

    // Fall back to title/author search
    const results = await this.searchBooks(book.title, book.author);

    // Simple scoring algorithm
    if (results.length > 0) {
      const scored = results.map((hb) => {
        let score = 0;
        const titleMatch = this.stringSimilarity(book.title.toLowerCase(), hb.title.toLowerCase());
        score += titleMatch * 70;

        const authorNames = hb.authors.map((a) => a.name).join(' ').toLowerCase();
        const authorMatch = this.stringSimilarity(book.author.toLowerCase(), authorNames);
        score += authorMatch * 30;

        return { book: hb, score };
      });

      scored.sort((a, b) => b.score - a.score);

      // Return best match if score > 60
      if (scored[0]!.score > 60) {
        return scored[0]!.book;
      }
    }

    return null;
  }

  private stringSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    if (longer.length === 0) return 1.0;
    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = [];
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= str1.length; j++) {
      matrix[0]![j] = j;
    }
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i]![j] = matrix[i - 1]![j - 1]!;
        } else {
          matrix[i]![j] = Math.min(
            matrix[i - 1]![j - 1]! + 1,
            matrix[i]![j - 1]! + 1,
            matrix[i - 1]![j]! + 1,
          );
        }
      }
    }
    return matrix[str2.length]![str1.length]!;
  }

  /**
   * Get all reads for a user book
   */
  async getAllReads(userBookId: string): Promise<any[]> {
    try {
      const data = await this.graphqlRequest<{ user_books: any[] }>(GET_ALL_READS_QUERY, {
        userBookId: parseInt(userBookId, 10),
      });

      if (!data.user_books || data.user_books.length === 0) {
        return [];
      }

      return data.user_books[0].user_book_reads || [];
    } catch (error) {
      console.error('Failed to get all reads:', error);
      return [];
    }
  }

  /**
   * Delete a specific read by ID
   */
  async deleteRead(readId: number): Promise<boolean> {
    try {
      await this.graphqlRequest<{ delete_user_book_read: { id: number } }>(DELETE_READ_MUTATION, {
        readId,
      });
      return true;
    } catch (error) {
      console.error('Failed to delete read:', error);
      return false;
    }
  }

  /**
   * Clean up duplicate reads, keeping only the most recent one with progress
   */
  async cleanupDuplicateReads(userBookId: string): Promise<{ deleted: number; kept?: number }> {
    try {
      const reads = await this.getAllReads(userBookId);

      if (reads.length <= 1) {
        this.debugLog('[Hardcover] No duplicate reads to clean up');
        return { deleted: 0 };
      }

      this.debugLog(`[Hardcover] Found ${reads.length} reads, cleaning up duplicates...`);

      // Find the read with the highest progress (most recent reading position)
      let bestRead = reads[0];
      for (const read of reads) {
        if ((read.progress_pages || 0) > (bestRead.progress_pages || 0)) {
          bestRead = read;
        }
      }

      this.debugLog(`[Hardcover] Keeping read ID ${bestRead.id} with progress: ${bestRead.progress_pages} pages`);

      // Delete all other reads
      let deleted = 0;
      for (const read of reads) {
        if (read.id !== bestRead.id) {
          const success = await this.deleteRead(read.id);
          if (success) {
            deleted++;
            this.debugLog(`[Hardcover] Deleted read ID ${read.id}`);
          }
        }
      }

      this.debugLog(`[Hardcover] Cleanup complete: deleted ${deleted} reads, kept read ID ${bestRead.id}`);
      return { deleted, kept: bestRead.id };
    } catch (error) {
      console.error('Failed to cleanup duplicate reads:', error);
      return { deleted: 0 };
    }
  }
}
