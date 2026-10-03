// Test helpers: build canned HTTP responses and a recording mock transport based
// on Node's built-in `node:test` mock facility. No real network is ever touched
// in the unit suite.

import { mock } from "node:test";
import type { Transport, HttpRequest, HttpResponse } from "../src/client/http.js";
import { StrahlenschutzClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";

export function jsonResponse(body: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

export function rawResponse(
  data: string | Buffer,
  contentType: string,
  status = 200,
): HttpResponse {
  return {
    status,
    headers: { "content-type": contentType },
    body: Buffer.isBuffer(data) ? data : Buffer.from(data),
  };
}

export interface MockTransport {
  transport: Transport;
  /** All requests the transport has received, in order. */
  readonly calls: HttpRequest[];
  /** The most recent request. */
  last(): HttpRequest;
}

/**
 * Build a mock transport from a responder function. The returned object records
 * every request so tests can assert on method/url/headers.
 */
export function makeMockTransport(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): MockTransport {
  const calls: HttpRequest[] = [];
  const fn = mock.fn(async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return responder(req);
  });
  return {
    transport: fn as unknown as Transport,
    calls,
    last: () => {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("mock transport has not been called");
      return c;
    },
  };
}

/** A transport that always returns the same JSON body. */
export function constantJson(body: unknown, status = 200): MockTransport {
  return makeMockTransport(() => jsonResponse(body, status));
}

/** The body the live GeoServer sent for `sortBy=bogus_prop` (2026-09-26). */
export const LIVE_EXCEPTION_REPORT =
  '<?xml version="1.0" encoding="UTF-8"?><ows:ExceptionReport xmlns:xs="http://www.w3.org/2001/XMLSchema" ' +
  'xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.0.0" ' +
  'xsi:schemaLocation="http://www.opengis.net/ows/1.1 https://www.imis.bfs.de/geoserver-public/schemas/ows/1.1.0/owsAll.xsd">\n' +
  '  <ows:Exception exceptionCode="InvalidParameterValue" locator="GetFeature">\n' +
  "    <ows:ExceptionText>Illegal property name: bogus_prop for feature type opendata:odlinfo_odl_1h_latest</ows:ExceptionText>\n" +
  "  </ows:Exception>\n</ows:ExceptionReport>\n";

/** What the CLI did with one input: exit code, captured output, requests sent. */
export interface CliOutcome {
  code: number;
  out: string;
  err: string;
  requests: HttpRequest[];
}

/** What the library did with the same input: its value or error, requests sent. */
export interface LibOutcome {
  ok: boolean;
  value?: unknown;
  error?: unknown;
  requests: HttpRequest[];
}

/**
 * Send one input through the CLI (`run(argv)`, its client built on a recording mock
 * transport) and through the library (`call(transport)`, typically
 * `new StrahlenschutzClient({ transport, ... }).method(...)`) on the same recording
 * transport, and return both outcomes, each with the requests it sent. A
 * synchronous throw from the library call (constructor validation) is captured like
 * a rejection. A parity test asserts that both reject without a request, or both
 * send the same requests.
 */
export async function parity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () =>
    jsonResponse({ type: "FeatureCollection", features: [] }),
): Promise<{ cli: CliOutcome; lib: LibOutcome }> {
  const mt = makeMockTransport(responder);
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (options) => new StrahlenschutzClient({ ...options, transport: mt.transport }),
  });
  const cliCount = mt.calls.length;
  const cli: CliOutcome = { code, out: out.join("\n"), err: err.join("\n"), requests: mt.calls.slice(0, cliCount) };

  let lib: LibOutcome;
  try {
    const value = await call(mt.transport);
    lib = { ok: true, value, requests: mt.calls.slice(cliCount) };
  } catch (error) {
    lib = { ok: false, error, requests: mt.calls.slice(cliCount) };
  }
  return { cli, lib };
}
