import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const names = ["20261014120000_payment_control_center", "20261014150000_advanced_network_monitoring", "20261025120000_payment_transport_evidence", "20261029120000_payment_diagnostic_capture", "20261029121000_order_checkout_lookup_index"];
// Only the mirrored payment migration chain: historical release squashing means
// unrelated legacy and release directories intentionally do not mirror entirely.
const normalize = text => text.replaceAll("\r\n", "\n").trim();
for (const name of names) {
  const [release, legacy] = await Promise.all(["migrations-release", "migrations"].map(root => readFile(new URL(`../prisma/${root}/${name}/migration.sql`, import.meta.url), "utf8")));
  assert.equal(normalize(release), normalize(legacy), `Payment migration mirror mismatch: ${name}`);
}
const config = await readFile(new URL("../prisma.config.ts", import.meta.url), "utf8");
assert.match(config, /path:\s*"prisma\/migrations-release"/);
console.log(JSON.stringify({ paymentMigrationMirrorsChecked: names.length, activeReleasePath: "prisma/migrations-release", databaseConnections: 0 }));
