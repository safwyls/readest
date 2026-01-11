/**
 * Hardcover.app GraphQL queries and mutations
 * API Documentation: https://docs.hardcover.app/api/
 * Based on: https://github.com/Billiam/hardcoverapp.koplugin
 */

export const GET_ME_QUERY = `
  query {
    me {
      id
      account_privacy_setting_id
    }
  }
`;

export const SEARCH_BOOKS_QUERY = `
  query SearchBooks($query: String!, $perPage: Int) {
    search(query: $query, query_type: "Book", per_page: $perPage) {
      results
    }
  }
`;

export const HYDRATE_BOOKS_QUERY = `
  query HydrateBooks($ids: [Int!]) {
    books(where: { id: { _in: $ids }}) {
      id
      title
      cached_image
      contributions: cached_contributors
    }
  }
`;

export const GET_USER_BOOK_QUERY = `
  query GetUserBook($userBookId: Int!) {
    user_books(where: { id: { _eq: $userBookId } }, limit: 1) {
      id
      book_id
      status_id
      edition_id
      book {
        pages
      }
      edition {
        pages
      }
      user_book_reads(order_by: {id: asc}) {
        id
        started_at
        finished_at
        progress_pages
        edition_id
      }
    }
  }
`;

export const CREATE_READ_MUTATION = `
  mutation CreateRead($userBookId: Int!, $pages: Int, $editionId: Int, $startedAt: date) {
    insert_user_book_read(user_book_id: $userBookId, user_book_read: {
      progress_pages: $pages,
      edition_id: $editionId,
      started_at: $startedAt
    }) {
      error
      user_book_read {
        id
        progress_pages
        edition_id
        started_at
      }
    }
  }
`;

export const UPDATE_PROGRESS_MUTATION = `
  mutation UpdateProgress($readId: Int!, $pages: Int, $editionId: Int, $startedAt: date) {
    update_user_book_read(id: $readId, object: {
      progress_pages: $pages,
      edition_id: $editionId,
      started_at: $startedAt
    }) {
      error
      user_book_read {
        id
        progress_pages
        edition_id
        started_at
      }
    }
  }
`;

export const CREATE_USER_BOOK_MUTATION = `
  mutation CreateUserBook($object: UserBookCreateInput!) {
    insert_user_book(object: $object) {
      error
      user_book {
        id
        book_id
        status_id
      }
    }
  }
`;

export const UPDATE_STATUS_MUTATION = `
  mutation UpdateStatus($userBookId: Int!, $statusId: Int!) {
    update_user_book(id: $userBookId, object: { status_id: $statusId }) {
      error
      user_book {
        id
        status_id
      }
    }
  }
`;

export const DELETE_READ_MUTATION = `
  mutation DeleteRead($readId: Int!) {
    delete_user_book_read(id: $readId) {
      id
    }
  }
`;

export const GET_ALL_READS_QUERY = `
  query GetAllReads($userBookId: Int!) {
    user_books(where: { id: { _eq: $userBookId } }) {
      id
      user_book_reads(order_by: {id: asc}) {
        id
        started_at
        finished_at
        progress_pages
        edition_id
      }
    }
  }
`;
