/**
 * Temporary test script to cleanup duplicate Hardcover reads
 * Run this from the browser console:
 *
 * import('/src/services/sync/testHardcoverCleanup').then(m => m.runCleanup('YOUR_HARDCOVER_ID'))
 */

import { useSettingsStore } from '@/store/settingsStore';
import { HardcoverClient } from './HardcoverClient';

export async function runCleanup(hardcoverId: string) {
  try {
    const settings = useSettingsStore.getState().settings.hardcover;

    if (!settings.enabled || !settings.apiToken) {
      console.error('[Hardcover Cleanup] Hardcover sync is not enabled or API token is missing');
      return;
    }

    const client = new HardcoverClient(settings);

    console.log(`[Hardcover Cleanup] Starting cleanup for user_book ID: ${hardcoverId}`);

    // First, show all reads
    const reads = await client.getAllReads(hardcoverId);
    console.log(`[Hardcover Cleanup] Found ${reads.length} reads:`);
    console.table(reads.map(r => ({
      id: r.id,
      progress_pages: r.progress_pages,
      started_at: r.started_at,
      finished_at: r.finished_at,
      edition_id: r.edition_id,
    })));

    // Confirm before deleting
    const confirmed = confirm(`Found ${reads.length} reads. Do you want to keep only the one with the highest progress and delete the rest?`);

    if (!confirmed) {
      console.log('[Hardcover Cleanup] Cleanup cancelled');
      return;
    }

    // Run cleanup
    const result = await client.cleanupDuplicateReads(hardcoverId);
    console.log(`[Hardcover Cleanup] Deleted ${result.deleted} duplicate reads, kept read ID: ${result.kept}`);

    // Show remaining reads
    const remainingReads = await client.getAllReads(hardcoverId);
    console.log(`[Hardcover Cleanup] Remaining reads: ${remainingReads.length}`);
    console.table(remainingReads.map(r => ({
      id: r.id,
      progress_pages: r.progress_pages,
      started_at: r.started_at,
      finished_at: r.finished_at,
      edition_id: r.edition_id,
    })));

    return result;
  } catch (error) {
    console.error('[Hardcover Cleanup] Error:', error);
  }
}

// For convenience, you can also run directly:
// import('/src/services/sync/testHardcoverCleanup').then(m => m.runCleanup('11078910'))
