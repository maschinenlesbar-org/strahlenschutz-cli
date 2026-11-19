// How the MCP server reaches this repository's client. The server's generic files (server.ts,
// limiter.ts, config.ts, run.ts, result.ts: the kit, the same in every repository) import the
// client only through this file, under the names below; the names on the right are this
// client's. Per repository, like tools.ts: a client whose names or functions differ adapts here.

import { DEFAULT_BASE_URL } from "@maschinenlesbar.org/strahlenschutz-client";

export {
  StrahlenschutzClient as Client,
  StrahlError as ClientError,
  StrahlNetworkError as NetworkError,
  baseUrlProblem,
  DEFAULT_BASE_URL,
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "@maschinenlesbar.org/strahlenschutz-client";
export { sizeLimitMessage } from "@maschinenlesbar.org/strahlenschutz-client/internal/http";
export { cutText, toWellFormed } from "@maschinenlesbar.org/strahlenschutz-client/internal/errors";

/** The path of the ODL-Info open-data services under the base URL: the client's WFS is `ows` below it. */
const API_PATH = "/ogc/opendata";

/** The API's base as a result's `source` starts with it (`--base-url`, else the default, plus the open-data path). */
export function apiBase(baseUrl: string | undefined): string {
  return `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}${API_PATH}`;
}
