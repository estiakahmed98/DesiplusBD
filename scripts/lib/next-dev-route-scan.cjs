// Dev-only filesystem completion for Next 16.3.7's partial Watchpack startup
// scan. No application modules, environment loading, HTTP or database access.
function collectRouteFiles(roots, fileSystem, pathApi, isPageFile) {
  const files = [];
  function visit(directory) {
    let entries;
    try { entries = fileSystem.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const filename = pathApi.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && isPageFile(filename)) files.push(filename);
    }
  }
  for (const root of roots) if (root) visit(root);
  return files;
}
function completeRouteEntries(watched, snapshot, fileSystem) {
  // Never mutate Watchpack's map. Existing metadata remains authoritative when
  // available; stat only fills real startup files omitted by a partial scan.
  const complete = new Map(watched);
  for (const filename of snapshot) {
    try {
      const stat = fileSystem.statSync(filename);
      if (!stat.isFile()) { complete.delete(filename); continue; }
      if (complete.get(filename)?.accuracy === undefined) {
        complete.set(filename, { timestamp: stat.mtimeMs, safeTime: stat.mtimeMs, accuracy: 1 });
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      complete.delete(filename);
    }
  }
  return complete;
}
module.exports = { collectRouteFiles, completeRouteEntries };
