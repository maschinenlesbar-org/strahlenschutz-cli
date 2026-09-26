// Public entry point for the API client library.

export { StrahlenschutzClient, DEFAULT_SORT_BY } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  MAX_DETAIL_LENGTH,
  MAX_RETRY_AFTER_MS,
  owsExceptionText,
  parseRetryAfter,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  StrahlError,
  StrahlApiError,
  StrahlNetworkError,
  StrahlParseError,
  redactUrl,
} from "./errors.js";

export * from "./enums.js";
export * from "./types.js";
