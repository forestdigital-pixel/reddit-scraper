/**
 * Response envelope and pagination utilities.
 *
 * Provides a standard `ApiResponse<T>` envelope for all API responses
 * and pagination helpers for list endpoints.
 *
 * **Validates: Requirements 10.2, 10.8**
 */

// ---------------------------------------------------------------------------
// ApiResponse envelope
// ---------------------------------------------------------------------------

/**
 * Standard API response envelope used by all endpoints.
 */
export interface ApiResponse<T> {
  status: 'success' | 'error';
  data: T | null;
  error: string | null;
  pagination?: PaginationInfo;
}

export interface PaginationInfo {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Response helpers — exported for property testing (Properties 24, 27)
// ---------------------------------------------------------------------------

/**
 * Creates a success response envelope.
 *
 * When `status` is `'success'`, `error` is always `null`.
 */
export function successResponse<T>(
  data: T,
  pagination?: PaginationInfo,
): ApiResponse<T> {
  const response: ApiResponse<T> = {
    status: 'success',
    data,
    error: null,
  };
  if (pagination) {
    response.pagination = pagination;
  }
  return response;
}

/**
 * Creates an error response envelope.
 *
 * When `status` is `'error'`, `data` is always `null`.
 */
export function errorResponse(error: string): ApiResponse<null> {
  return {
    status: 'error',
    data: null,
    error,
  };
}

// ---------------------------------------------------------------------------
// Pagination parsing
// ---------------------------------------------------------------------------

/** Default page size when none is specified */
const DEFAULT_PAGE_SIZE = 25;

/** Maximum allowed page size */
const MAX_PAGE_SIZE = 100;

export interface ParsedPagination {
  page: number;
  pageSize: number;
}

/**
 * Parses `page` and `page_size` query parameters into validated pagination
 * values.
 *
 * - `page` defaults to 1, minimum 1
 * - `page_size` defaults to 25, minimum 1, maximum 100
 *
 * Exported for property testing (Property 27).
 */
export function parsePagination(query: {
  page?: string;
  page_size?: string;
}): ParsedPagination {
  const rawPage = Number(query.page);
  const rawPageSize = Number(query.page_size);

  const page = Number.isFinite(rawPage) && rawPage >= 1
    ? Math.floor(rawPage)
    : 1;

  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1
    ? Math.min(Math.floor(rawPageSize), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;

  return { page, pageSize };
}
