// Test helpers of this server's own tests and the adapters of the conformance tests: a mock
// upstream on the ODL-Info WFS (the client's fixtures: live answers recorded on 2026-11-19, cut
// down to 24 stations, Herrischried's hourly and Flensburg's daily series), and the client's
// transport helpers. The generic harness (a connection, a config, a log recorder, the HTTP server)
// is harness.ts.

export * from "@maschinenlesbar.org/strahlenschutz-client/test/helpers";
export * from "@maschinenlesbar.org/strahlenschutz-client/test/fixtures";
