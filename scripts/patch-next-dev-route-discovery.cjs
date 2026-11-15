/* eslint-disable @typescript-eslint/no-require-imports -- npm lifecycle must run in plain Node before any TS/ESM loader is installed. */
// Narrow dev-only backport for the installed Next 16.3.7 route-discovery race.
// Upstream diagnosis/fix: https://github.com/vercel/next.js/blob/v16.4.3/packages/next/src/server/lib/router-utils/setup-dev-bundler.ts
// Snapshot/stat completion is used rather than publishing a partial startup
// route table. Production routing, proxy/RBAC and provider handlers are untouched.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { collectRouteFiles, completeRouteEntries } = require("./lib/next-dev-route-scan.cjs");
const marker = "DESHI_NEXT_DEV_ROUTE_SCAN_V1";
const originals = {
  cjs: "fbba0195b8f5c7eb2bd33f4abb75e590f7a895c0f84aab85470d95b41d6b0748",
  esm: "15076e4ff50508f91c20ee7de385d4a3725ec916867e075fa6c033297216598c",
};
const digest = text => createHash("sha256").update(text).digest("hex");
function replaceOnce(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw new Error("NEXT_DEV_SCAN_PATCH_ANCHOR_CHANGED");
  return source.replace(needle, replacement);
}
function patchSource(input, format, version) {
  const source = input.replaceAll("\r\n", "\n");
  if (!source.includes(marker) && source.includes("initialPageFiles")) return { source: input, changed: false, reason: "UPSTREAM_GUARD_PRESENT" };
  if (version !== "16.3.7" || !originals[format]) throw new Error("NEXT_DEV_SCAN_VERSION_REVIEW_REQUIRED");
  const original = source
    .replace(/\/\* DESHI_NEXT_DEV_ROUTE_SCAN_V1_SNAPSHOT_BEGIN \*\/[\s\S]*?\/\* DESHI_NEXT_DEV_ROUTE_SCAN_V1_SNAPSHOT_END \*\/\n/, "")
    .replace(/\/\* DESHI_NEXT_DEV_ROUTE_SCAN_V1_ENTRIES_BEGIN \*\/[\s\S]*?\/\* DESHI_NEXT_DEV_ROUTE_SCAN_V1_ENTRIES_END \*\//, "const knownFiles = wp.getTimeInfoEntries();");
  if (digest(original) !== originals[format]) throw new Error("NEXT_DEV_SCAN_SOURCE_REVIEW_REQUIRED");
  const fsName = format === "cjs" ? "_fs.default" : "fs";
  const pathName = format === "cjs" ? "_path.default" : "path";
  const snapshot = `/* ${marker}_SNAPSHOT_BEGIN */\nconst deshiCollectRouteFiles = ${collectRouteFiles.toString()};\nconst deshiCompleteRouteEntries = ${completeRouteEntries.toString()};\nconst deshiInitialRouteFiles = deshiCollectRouteFiles([pagesDir, appDir], ${fsName}, ${pathName}, validFileMatcher.isPageFile);\n/* ${marker}_SNAPSHOT_END */\n`;
  const entries = `/* ${marker}_ENTRIES_BEGIN */\nconst knownFiles = deshiCompleteRouteEntries(wp.getTimeInfoEntries(), deshiInitialRouteFiles, ${fsName});\n/* ${marker}_ENTRIES_END */`;
  const patched = replaceOnce(replaceOnce(original, "let resolved = false;", snapshot + "let resolved = false;"), "const knownFiles = wp.getTimeInfoEntries();", entries).replaceAll("\r\n", "\n");
  if (source.includes(marker) && source !== patched) throw new Error("NEXT_DEV_SCAN_PATCH_CONTENT_CHANGED");
  return { source: patched, changed: source !== patched, reason: source === patched ? "ALREADY_APPLIED" : "APPLIED" };
}
function applyPatch() {
  const nextPackage = require.resolve("next/package.json", { paths: [path.resolve(__dirname, "..")] });
  const nextRoot = path.dirname(nextPackage);
  const version = JSON.parse(fs.readFileSync(nextPackage, "utf8")).version;
  const results = ["cjs", "esm"].map(format => {
    const file = path.join(nextRoot, "dist", ...(format === "esm" ? ["esm"] : []), "server/lib/router-utils/setup-dev-bundler.js");
    return { file, ...patchSource(fs.readFileSync(file, "utf8"), format, version) };
  });
  // Validate both modules before writing either one. Unknown vendor changes fail
  // closed and require review; never guess source replacements after an upgrade.
  for (const result of results) if (result.changed) {
    const temporary = result.file + ".deshi-route-scan.tmp";
    fs.writeFileSync(temporary, result.source);
    fs.renameSync(temporary, result.file);
  }
  console.log(JSON.stringify({ nextVersion: version, devRouteDiscoveryPatch: results.map(result => result.reason) }));
}
module.exports = { patchSource, applyPatch, marker };
if (require.main === module) applyPatch();
