import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { collectRouteFiles, completeRouteEntries } = require("../scripts/lib/next-dev-route-scan.cjs");
const { patchSource, marker } = require("../scripts/patch-next-dev-route-discovery.cjs");
const paths = ["/app/api/admin/payment-control/diagnostics/route.ts", "/app/api/admin/payment-control/diagnostics/[id]/route.ts", "/app/api/admin/payment-control/diagnostics/captures/route.ts"];
function fileSystem(removed = new Set()) {
  return { statSync(filename) {
    if (removed.has(filename)) throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
    return { isFile: () => filename !== "/app/a-directory.ts", mtimeMs: 1000 };
  } };
}
test("reproduces Next 16.3.7 publishing a partial scan that omits both Investigate endpoints", () => {
  const firstAggregation = new Map([[paths[0], { accuracy: 1, timestamp: 1000 }]]);
  const before = [...firstAggregation].filter(([, meta]) => meta.accuracy !== undefined).map(([file]) => file);
  assert.equal(before.includes(paths[1]), false); assert.equal(before.includes(paths[2]), false);
  const completed = completeRouteEntries(firstAggregation, paths, fileSystem());
  assert.ok(paths.every(file => completed.get(file)?.accuracy !== undefined));
  assert.equal(firstAggregation.size, 1, "Watchpack's own map must not be mutated");
});
test("pending metadata is filled from actual file stat; existing metadata is preserved", () => {
  const known = { accuracy: 2000, timestamp: 1001 }, watched = new Map([[paths[0], known], [paths[1], {}]]);
  const completed = completeRouteEntries(watched, paths, fileSystem());
  assert.equal(completed.get(paths[0]), known);
  assert.equal(completed.get(paths[1]).timestamp, 1000);
  assert.ok(completed.get(paths[2]).accuracy !== undefined);
});
test("deleted files and directories cannot become phantom API routes", () => {
  const stale = new Map([[paths[1], { accuracy: 1 }], ["/app/a-directory.ts", {}]]);
  const result = completeRouteEntries(stale, [...paths, "/app/a-directory.ts"], fileSystem(new Set([paths[1]])));
  assert.equal(result.has(paths[1]), false); assert.equal(result.has("/app/a-directory.ts"), false);
  assert.equal(result.has(paths[2]), true);
});
test("filesystem permission errors fail explicitly instead of publishing an incomplete route table", () => {
  assert.throws(() => completeRouteEntries(new Map(), paths, { statSync() { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }), /denied/);
});
test("startup collection is scoped to app/pages roots and does not traverse symlinks", () => {
  const entries = {
    "/app": [{ name: "api", kind: "directory" }, { name: "linked", kind: "symlink" }],
    "/app/api": [{ name: "route.ts", kind: "file" }, { name: "image.png", kind: "file" }],
  };
  const fs = { readdirSync(dir) { assert.ok(dir in entries); return entries[dir].map(e => ({ name: e.name, isFile: () => e.kind === "file", isDirectory: () => e.kind === "directory" })); } };
  assert.deepEqual(collectRouteFiles([undefined, "/app"], fs, { join: (...parts) => parts.join("/") }, name => name.endsWith(".ts")), ["/app/api/route.ts"]);
});
for (const format of ["cjs", "esm"]) test(`reviewed ${format} patch is version/source guarded and idempotent`, () => {
  const file = require.resolve(`next/dist/${format === "esm" ? "esm/" : ""}server/lib/router-utils/setup-dev-bundler.js`);
  const before = readFileSync(file, "utf8"), first = patchSource(before, format, "16.3.7");
  assert.ok(first.source.includes(marker)); assert.equal(patchSource(first.source, format, "16.3.7").changed, false);
  assert.throws(() => patchSource(before + "\n// unexpected vendor change", format, "16.3.7"), /SOURCE_REVIEW_REQUIRED/);
  assert.throws(() => patchSource(before, format, "16.3.8"), /VERSION_REVIEW_REQUIRED/);
});
test("an upstream fixed release is left intact", () => {
  const upstream = "const initialPageFiles = []; // upstream startup guard";
  assert.equal(patchSource(upstream, "cjs", "16.4.3").reason, "UPSTREAM_GUARD_PRESENT");
});
