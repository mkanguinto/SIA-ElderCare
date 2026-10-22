'use strict';

/**
 * Page-based pagination for list endpoints (REST API design, Batch 2).
 *
 *   GET /api/...?page=2&pageSize=25
 *   -> { ...items..., pagination: { page, pageSize, totalItems, totalPages, hasNext, hasPrev } }
 *
 * `limit` (v1 clients) is still accepted as an alias for pageSize and keeps its old clamping, so
 * existing dashboards keep working. Explicit page / pageSize values are validated strictly (422).
 */
const MAX_PAGE = 10000;

/**
 * @param {object} query  req.query
 * @param {{defaultPageSize?:number, maxPageSize?:number}} [opts]
 * @returns {{page:number, pageSize:number, offset:number, errors:string[]}}
 */
function parsePagination(query = {}, { defaultPageSize = 50, maxPageSize = 200 } = {}) {
  const errors = [];
  const strictInt = (raw, name, min, max) => {
    const s = String(raw).trim();
    const n = Number(s);
    if (!/^\d+$/.test(s) || n < min || n > max) {
      errors.push(`${name} must be an integer from ${min} to ${max}`);
      return null;
    }
    return n;
  };

  let pageSize = defaultPageSize;
  if (query.pageSize !== undefined) {
    pageSize = strictInt(query.pageSize, 'pageSize', 1, maxPageSize) ?? defaultPageSize;
  } else if (query.limit !== undefined) {
    pageSize = Math.min(Math.max(parseInt(query.limit, 10) || defaultPageSize, 1), maxPageSize);
  }
  const page = query.page !== undefined ? strictInt(query.page, 'page', 1, MAX_PAGE) ?? 1 : 1;
  return { page, pageSize, offset: (page - 1) * pageSize, errors };
}

/** The `pagination` envelope returned next to the items. */
function pageInfo({ page, pageSize }, totalItems) {
  const total = Number(totalItems) || 0;
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  return { page, pageSize, totalItems: total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 };
}

module.exports = { parsePagination, pageInfo };
