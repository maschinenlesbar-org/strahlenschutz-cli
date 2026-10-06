// Conformance test P21 (follow-up round 2026-10-06): README.md ships in the npm tarball and
// is shown on npmjs.com, so every relative link in it must point to a file the package ships.
// A document the tarball leaves out is linked by its absolute GitHub URL instead
// (https://github.com/maschinenlesbar-org/<repo>/blob/main/<path>). Dependency-free: reads
// package.json `files` rather than running `npm pack`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// dist/test/ -> the repository root.
const ROOT = new URL("../../", import.meta.url);
const readme = readFileSync(new URL("README.md", ROOT), "utf8");
const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")) as { name: string; files?: string[] };

/** npm ships these whatever `files` says. */
const ALWAYS_SHIPPED = [/^README\.md$/i, /^LICEN[CS]E(\.[^/]*)?$/i, /^package\.json$/];

/** A `files` entry as a matcher: a plain path matches itself and everything below it. */
function entryMatcher(entry: string): (path: string) => boolean {
  const clean = entry.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!clean.includes("*")) return (path) => path === clean || path.startsWith(clean + "/");
  const pattern = clean
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  const re = new RegExp(`^${pattern}(/.*)?$`);
  return (path) => re.test(path);
}

const shippedMatchers = (pkg.files ?? []).filter((entry) => !entry.startsWith("!")).map(entryMatcher);

function shipped(path: string): boolean {
  return ALWAYS_SHIPPED.some((re) => re.test(path)) || shippedMatchers.some((match) => match(path));
}

/** Relative link targets of every `](target)` in the README, anchors stripped. */
function relativeTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1]!;
    if (/^(https?:|mailto:|#)/i.test(target)) continue;
    const path = target.replace(/#.*$/, "").replace(/^\.\//, "");
    if (path !== "") targets.push(path);
  }
  return targets;
}

test("P21: every relative README link points to a file the npm package ships", () => {
  const repo = pkg.name.replace(/^@[^/]+\//, "");
  const broken = relativeTargets(readme).filter((path) => !shipped(path));
  assert.deepEqual(
    broken,
    [],
    `README links to files the npm package doesn't ship (they 404 on npmjs.com); link them as ` +
      `https://github.com/maschinenlesbar-org/${repo}/blob/main/<path>: ${broken.join(", ")}`,
  );
});

test("P21: the check sees the README's relative links at all", () => {
  // Guards the regex: the README links at least one shipped document relatively.
  assert.ok(relativeTargets(readme).length > 0);
});
