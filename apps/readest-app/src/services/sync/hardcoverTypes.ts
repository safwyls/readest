/**
 * Hardcover.app API response types
 * GraphQL API endpoint: https://api.hardcover.app/v1/graphql
 */

export interface HardcoverAuthor {
  name: string;
}

export interface HardcoverBook {
  id: string;
  title: string;
  subtitle?: string;
  authors: HardcoverAuthor[];
  isbn_10?: string;
  isbn_13?: string;
  image_url?: string;
}

export interface HardcoverStatus {
  status_id: number; // 1=Want to Read, 2=Currently Reading, 3=Read, 4=DNF
  status: string;
}

export interface HardcoverProgress {
  page?: number;
  percentage?: number;
  updated_at: string;
  edition_id?: number;
  started_at?: string;
}

export interface HardcoverUserBook {
  id: string;
  book: HardcoverBook;
  status: HardcoverStatus;
  progress?: HardcoverProgress | null;
  readId?: number; // ID of the user_book_read for updating progress
  editionId?: number; // Edition ID for the book
  remoteTotalPages?: number | null; // Total pages in the remote edition/book
}

export type HardcoverReadingStatus = 'WANT_TO_READ' | 'CURRENTLY_READING' | 'READ' | 'DNF' | null;

export interface HardcoverSyncProgress {
  userBookId: string;
  page?: number;
  percentage?: number;
  timestamp: string;
  device?: string;
}

export interface HardcoverConflictData {
  local: {
    percentage: number;
    page?: number;
    preview: string;
    timestamp: number;
  };
  remote: HardcoverSyncProgress & {
    preview: string;
  };
}

// Status ID mapping for Hardcover API
export const HARDCOVER_STATUS_MAP: Record<HardcoverReadingStatus, number> = {
  WANT_TO_READ: 1,
  CURRENTLY_READING: 2,
  READ: 3,
  DNF: 4,
  null: 0,
};
