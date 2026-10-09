// Public entry point for the API client library.

export { StrahlenschutzClient, DEFAULT_SORT_BY } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  cleartextProblem,
  validateBaseUrl,
  MAX_REDIRECTS,
  MAX_RETRIES,
  MAX_DETAIL_LENGTH,
  MAX_RETRY_AFTER_MS,
  owsExceptionText,
  parseRetryAfter,
  isTransientNetworkError,
  serverTextForMessage,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport, sizeLimitMessage } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  StrahlError,
  StrahlApiError,
  StrahlNetworkError,
  StrahlNotFoundError,
  StrahlParseError,
  StrahlValidationError,
  credentialsIn,
  cutForMessage,
  cutText,
  MAX_QUOTED_LENGTH,
  MAX_QUOTED_URL_LENGTH,
  urlForMessage,
  redactCredentials,
  redactUrl,
  toWellFormed,
} from "./errors.js";
export {
  assertValid,
  baseUrlProblem,
  baseUrlWhitespaceProblem,
  featureKindProblem,
  headerValueProblem,
  intRangeProblem,
  isBlank,
  nonEmptyProblem,
  normalizeInput,
  normalizeSortBy,
  oneOfProblem,
  queryKeysProblem,
  sortByProblem,
  timeseriesResolutionProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./enums.js";
export * from "./types.js";
