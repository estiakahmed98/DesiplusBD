import assert from "node:assert/strict";
import test from "node:test";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { loadTransportSource as load } from "./helpers/payment-transport-uat.mjs";
import * as policy from "../lib/payment-control/diagnostic-policy.ts";
import { checkConsistency, paymentOrderCompatibility } from "../lib/payment-control/consistency.ts";
import { diagnosticReadiness } from "../lib/payment-control/diagnostic-readiness.ts";
import { requireCaptureAgentEnabled, requireCaptureEnabled } from "../lib/payment-control/capture-policy.ts";
import { captureCorrelation } from "../lib/payment-control/capture-correlation.ts";
import { TransportEvidenceQueue, retryableTransportWrite } from "../lib/payment-control/transport-queue.ts";
import { ObservedConnection } from "../lib/payment-control/transport-observer.ts";
import { isFrontendDiagnosticOriginAllowed } from "../lib/payment-control/frontend-origin.ts";
const requestId = "11111111-1111-4111-8111-111111111111";
const snapshot = { payment: { id: 1, status: "CAPTURED", amount: "100", currency: "BDT", createdAt: new Date().toISOString() },
  order: { id: 7, status: "CONFIRMED", paymentStatus: "PAID", amount: "100", currency: "BDT" },
  settledPayments: 1, duplicateBankReferences: null, reservations: 0, stock: [], stockLimited: false,
  verificationRecorded: false, settlementRecorded: false, reconciliation: null, variantTotals: [] };
// Columns are the actual OrderStatus enum, in schema order. P/W/F/U are the
// documented state-only verdict, independent of verification and ledger checks.
const lifecycles = ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED", "FAILED", "REFUNDED"];
const matrix = {
  INITIATED: { UNPAID: "PPWWWWWWW", PAID: "WWWWWWWWW", REFUNDED: "WWWWWWWWW" },
  AUTHORIZED: { UNPAID: "PPWWWWWWW", PAID: "WWWWWWWWW", REFUNDED: "WWWWWWWWW" },
  CAPTURED: { UNPAID: "FFFFFFFFF", PAID: "PPPPPWWWW", REFUNDED: "WWWWWWWWW" },
  REFUNDED: { UNPAID: "FFFFFFFFF", PAID: "WWWWWWWWW", REFUNDED: "WWWWWPPWP" },
  FAILED: { UNPAID: "PPWWWPWPW", PAID: "UUUUUUUUU", REFUNDED: "UUUUUUUUU" },
  VOIDED: { UNPAID: "PPWWWPWPW", PAID: "UUUUUUUUU", REFUNDED: "UUUUUUUUU" },
};
for (const [payment, orders] of Object.entries(matrix)) for (const [orderPayment, verdicts] of Object.entries(orders))
  lifecycles.forEach((lifecycle, index) => test(`matrix ${payment}/${orderPayment}/${lifecycle}`, () => {
    const input = structuredClone(snapshot); input.payment.status = payment; input.order.paymentStatus = orderPayment;
    input.order.status = lifecycle; input.settledPayments = ["CAPTURED", "REFUNDED"].includes(payment) ? 1 : 0;
    const before = JSON.stringify(input);
    const verdict = { P: "PASS", W: "WARNING", F: "FAIL", U: "UNKNOWN" }[verdicts[index]];
    assert.equal(paymentOrderCompatibility(input), verdict);
    assert.equal(checkConsistency(input).find(c => c.code === "PAYMENT_ORDER_CONSISTENCY").status, verdict);
    assert.equal(JSON.stringify(input), before);
  }));
test("unknown enums, older failed attempts, absent verification/ledger and empty stock never imply financial success", () => {
  assert.equal(paymentOrderCompatibility({ ...snapshot, payment: { ...snapshot.payment, status: "NEW_STATE" } }), "UNKNOWN");
  assert.equal(paymentOrderCompatibility({ ...snapshot, order: { ...snapshot.order, status: "NEW_STATE" } }), "UNKNOWN");
  assert.equal(paymentOrderCompatibility({ ...snapshot, payment: { ...snapshot.payment, status: "FAILED" } }), "UNKNOWN");
  const checks = checkConsistency(snapshot);
  for (const code of ["PAYMENT_VERIFICATION_EVIDENCE", "INVENTORY_COMMIT_LEDGER", "NEGATIVE_AVAILABLE_STOCK", "INVENTORY_RESERVATION_INCONSISTENCY", "MULTI_WAREHOUSE_STOCK_MISMATCH"])
    assert.equal(checks.find(c => c.code === code).status, "NOT_OBSERVED", code);
  assert.equal(checkConsistency({ ...snapshot, commitLedger: { stockRequired: true, observed: true, matches: true, certainty: "CURRENT_CATALOG" } })
    .find(c => c.code === "INVENTORY_COMMIT_LEDGER").status, "UNKNOWN");
});

function browserFixture({ user = "owner", owner = "owner", guestToken = "VALID_FIXTURE_TOKEN", allowed = true, enabled = true, fail = false, serverRows } = {}) {
  const saved = new Map(), writes = [];
  const rows = serverRows ?? [{ orderId: 7, provider: "EPS", requestId, paymentId: null }, { orderId: 7, provider: "EPS", requestId, paymentId: 71 }];
  const prisma = { order: { findUnique: async ({ where }) => where.id === 7 ? { id: 7, userId: owner, payment_method: "EPS:1" } : null },
    paymentEvent: {
      findFirst: async ({ where }) => rows.find(r => r.requestId === where.requestId && r.orderId === where.orderId && r.provider === where.provider &&
        (!where.paymentId || r.paymentId !== null) && (!where.payment || r.paymentId === 71)) ?? null,
      createMany: async ({ data, skipDuplicates }) => { assert.equal(skipDuplicates, true); if (fail) throw new Error("PRIVATE_DB_ERROR");
        writes.push(...data); for (const row of data) if (!saved.has(row.id)) saved.set(row.id, row); return { count: data.length }; },
    } };
  const route = load("app/api/payment-diagnostics/frontend/route.ts", {
    "@/lib/payment-control/frontend-origin": { isFrontendDiagnosticOriginAllowed },
    "next/server": { NextResponse: Response }, "node:crypto": crypto,
    "next-auth/next": { getServerSession: async () => user ? { user: { id: user } } : null }, "@/lib/auth": { authOptions: {} },
    "@/lib/prisma": { prisma }, "@/lib/sslcommerz": { verifyPaymentInitToken: (_id, value) => value === guestToken },
    "@/lib/request-security": { rateLimitRequest: async () => ({ allowed }) }, "@/lib/network-monitor/policy": { readMonitorBody: request => request.json() },
    "@/lib/payment-control/diagnostic-policy": { ...policy, diagnosticsEnabled: () => enabled },
  }, { Request, Response, AbortSignal, Date });
  const send = (body = {}, origin = "https://shop.example") => route.POST(new Request("https://shop.example/api/payment-diagnostics/frontend", {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ orderId: 7, code: "FRONTEND_API_FAILED", durationMs: 20, requestId, ...body }) }));
  return { send, saved, writes, route };
}
test("browser collector binds later attempt instead of earlier null initiator, duplicate deliveries persist once", async () => {
  const f = browserFixture();
  const responses = await Promise.all([f.send(), f.send({ reportId: crypto.randomUUID() })]);
  assert.deepEqual(responses.map(r => r.status), [204, 204]); assert.equal(f.saved.size, 1);
  assert.equal([...f.saved.values()][0].paymentId, 71);
  assert.equal([...f.saved.values()][0].requestId, requestId);
  assert.equal(responses[0].headers.get("cache-control"), "private, no-store");
});
for (const [name, options, body, origin, status] of [
  ["foreign customer", { user: "other" }, {}, undefined, 403],
  ["guest without signed token", { owner: null, user: null }, {}, undefined, 403],
  ["guest with valid signed-token verifier", { owner: null, user: null }, { paymentInitToken: "VALID_FIXTURE_TOKEN" }, undefined, 204],
  ["foreign origin", {}, {}, "https://attacker.example", 403],
  ["unknown request", {}, { requestId: crypto.randomUUID() }, undefined, 400],
  ["request belongs to another order", { serverRows: [{ orderId: 8, provider: "EPS", requestId, paymentId: 72 }] }, {}, undefined, 400],
  ["client payment ID", {}, { paymentId: 72 }, undefined, 400],
  ["malformed request ID", {}, { requestId: "not-a-uuid" }, undefined, 400],
  ["malformed report ID", {}, { reportId: "not-a-uuid" }, undefined, 400],
  ["rate limit", { allowed: false }, {}, undefined, 429],
  ["persistence failure", { fail: true }, {}, undefined, 503],
]) test(`browser collector: ${name}`, async () => {
  const f = browserFixture(options), response = await f.send(body, origin);
  assert.equal(response.status, status); assert.equal(f.saved.size, status === 204 ? 1 : 0);
  assert.doesNotMatch(await response.text(), /PRIVATE_DB_ERROR/);
});
test("network reports remain order-only, repeated same nonce deduplicates", async () => {
  const f = browserFixture(), reportId = crypto.randomUUID();
  await f.send({ requestId: null, reportId }); await f.send({ requestId: null, reportId });
  assert.equal(f.saved.size, 1); assert.equal([...f.saved.values()][0].paymentId, null);
});
test("client fetch to collector persists visible attempt event without blocking payment/navigation or aborting keepalive", async () => {
  const f = browserFixture(), diagnostics = []; let paymentCalls = 0, navigated = false;
  const browser = load("lib/payment-control/browser-diagnostics.ts", {}, {
    process: { env: { NEXT_PUBLIC_PAYMENT_DIAGNOSTICS_ENABLED: "true" } }, crypto, performance,
    window: { location: { set href(_value) { navigated = true; } } },
    fetch: async (url, init) => {
      if (url.startsWith("/api/payment-diagnostics/")) {
        assert.equal(init.keepalive, true); assert.equal(init.signal, undefined);
        const pending = f.send(JSON.parse(init.body)); diagnostics.push(pending); return pending;
      }
      paymentCalls++; return new Response('{"redirectUrl":"https://fixture.invalid"}', { headers: { "X-Payment-Request-Id": requestId } });
    },
  });
  const response = await browser.diagnosticPaymentFetch("/api/eps/init", {}, { orderId: 7 });
  browser.diagnosticPaymentRedirect("https://fixture.invalid", response, { orderId: 7 });
  await Promise.all(diagnostics); assert.equal(paymentCalls, 1); assert.equal(navigated, true);
  assert.equal(f.saved.size, 2); assert.ok([...f.saved.values()].every(row => row.paymentId === 71));
});
test("browser without secure-context randomUUID still sends collection using server dedup fallback", async () => {
  const reports = [];
  const browser = load("lib/payment-control/browser-diagnostics.ts", {}, {
    process: { env: { NEXT_PUBLIC_PAYMENT_DIAGNOSTICS_ENABLED: "true" } }, crypto: {}, performance,
    fetch: async (url, init) => {
      if (url === "/api/payment-diagnostics/frontend") { reports.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
      return new Response("{}");
    },
  });
  assert.equal((await browser.diagnosticPaymentFetch("/api/eps/init", {}, { orderId: 7 })).status, 200);
  assert.equal(reports.length, 1); assert.equal(reports[0].reportId, undefined);
});

function queueFixture(write) {
  const tasks = [], delays = [];
  const queue = new TransportEvidenceQueue({ sanitize: value => value, write, schedule: task => tasks.push(task), delay: async ms => { delays.push(ms); } });
  return { queue, delays, flush: async () => { while (tasks.length) { tasks.shift()(); await queue.waitForIdle(); } } };
}
test("queue transient error recovers duplicate-safely with bounded backoff and preserves next evidence", async () => {
  let calls = 0; const f = queueFixture(async () => { if (++calls < 3) throw { code: "P1001" }; return calls === 3 ? "DUPLICATE" : "INSERTED"; });
  f.queue.enqueue([{ attemptId: "a" }, { attemptId: "b" }]); await f.flush();
  assert.deepEqual(f.delays, [250, 1000]); const s = f.queue.snapshot();
  assert.equal(s.retries, 2); assert.equal(s.recovered, 1); assert.equal(s.duplicates, 1); assert.equal(s.persisted, 1); assert.equal(s.dropped, 0);
});
test("queue permanent or exhausted failure drops only failed item and exposes gap, subsequent evidence persists", async () => {
  for (const failure of [{ code: "P2021" }, { code: "P2010", meta: { code: "55P03" } }]) {
    const f = queueFixture(async row => { if (row.attemptId === "a") throw failure; return "INSERTED"; });
    f.queue.enqueue([{ attemptId: "a" }, { attemptId: "b" }]); await f.flush(); const s = f.queue.snapshot();
    assert.equal(s.persisted, 1); assert.equal(s.dropped, 1); assert.equal(s.evidenceGap, true);
    assert.equal(s.writeErrors, failure.code === "P2021" ? 1 : 3); assert.equal(s.durability, "MEMORY_ONLY_LOST_ON_PROCESS_EXIT");
    assert.equal(s.scope, "CURRENT_PROCESS_ONLY");
  }
  assert.equal(retryableTransportWrite(new Error("connection failure secret payload")), false);
});
test("readiness exposes blockers without returning secrets, destinations or paths", () => {
  const env = { PAYMENT_DIAGNOSTICS_ENABLED: "true", NEXT_PUBLIC_PAYMENT_DIAGNOSTICS_ENABLED: "false", PAYMENT_TRANSPORT_MONITORING_MODE: "instrumented",
    PAYMENT_TRANSPORT_STORAGE_ENABLED: "true", PAYMENT_TRANSPORT_ALLOWED_PROVIDERS: "EPS", PAYMENT_TRANSPORT_ALLOWED_OPERATIONS: "AUTH",
    PAYMENT_CAPTURE_AGENT_TOKEN: "PRIVATE_SECRET", PAYMENT_DIAGNOSTICS_EVIDENCE_DIR: "PRIVATE_DIRECTORY" };
  const ready = diagnosticReadiness(env, "24.13.0", "7.20.0");
  assert.equal(ready.browser.status, "PUBLIC_FLAG_NOT_CONFIGURED_VERIFY_BROWSER_BUNDLE"); assert.equal(ready.transport.reason, "APPROVAL_REQUIRED");
  assert.equal(ready.transport.runtime.compatible, false);
  assert.doesNotMatch(JSON.stringify(ready), /PRIVATE_SECRET|PRIVATE_DIRECTORY/);
  assert.equal(diagnosticReadiness({ ...env, PAYMENT_CONTROL_LOGGING_ENABLED: "false" }).browser.status, "EVENT_STORAGE_OFF");
});
test("agent needs capture flags/TLS safeguards but not application persistent storage", () => {
  const env = { PAYMENT_DIAGNOSTICS_ENABLED: "true", PAYMENT_NETWORK_CAPTURE_ENABLED: "true" };
  assert.equal(requireCaptureAgentEnabled(env).seconds, 30);
  assert.throws(() => requireCaptureEnabled(env), /PRIVATE_EVIDENCE_STORAGE_REQUIRED/);
  assert.throws(() => requireCaptureAgentEnabled({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" }), /INSECURE_CAPTURE_TLS_CONFIGURATION/);
});
test("standalone agent starts and authenticates to controlled loopback without application evidence directory", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "payment-agent-startup-"));
  let acceptPoll;
  const polled = new Promise(accept => { acceptPoll = accept; });
  const token = "a".repeat(32);
  const controlPlane = createServer((request, response) => {
    if (request.url !== "/api/payment-diagnostics/capture-agent" || request.headers.authorization !== `Bearer ${token}` || request.headers["x-capture-agent-id"] !== "fixture-agent") {
      response.writeHead(401); response.end(); return;
    }
    response.writeHead(200, { "content-type": "application/json" }); response.end('{"job":null}'); acceptPoll();
  });
  await new Promise(accept => controlPlane.listen(0, "127.0.0.1", accept));
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { PAYMENT_DIAGNOSTICS_ENABLED: "true", PAYMENT_NETWORK_CAPTURE_ENABLED: "true",
    PAYMENT_CAPTURE_APP_ORIGIN: `http://127.0.0.1:${controlPlane.address().port}`, PAYMENT_CAPTURE_AGENT_TOKEN: token,
    PAYMENT_CAPTURE_AGENT_ID: "fixture-agent", PAYMENT_CAPTURE_TEMP_DIR: root,
    PAYMENT_CAPTURE_DUMPCAP: process.execPath, PAYMENT_CAPTURE_TSHARK: process.execPath, PAYMENT_CAPTURE_INTERFACE: "1" });
  assert.equal(env.PAYMENT_DIAGNOSTICS_EVIDENCE_DIR, undefined);
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/payment-capture-agent.ts"], { env, windowsHide: true, stdio: "ignore" });
  const closed = new Promise(accept => child.once("close", accept));
  let timer;
  try {
    await Promise.race([polled, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("AGENT_DID_NOT_POLL")), 8000); }),
      closed.then(() => { throw new Error("AGENT_EXITED_BEFORE_POLL"); })]);
    assert.deepEqual(await readdir(root), [], "Heartbeat did not create/capture packet evidence");
  } finally {
    clearTimeout(timer); child.kill("SIGKILL"); await closed;
    controlPlane.closeAllConnections(); await new Promise(accept => controlPlane.close(accept));
    const rel = relative(resolve(tmpdir()), resolve(root)); assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  }
});
test("shared connection/time overlap never upgrades packet attribution or claims exclusive ownership", () => {
  const window = { firstPacketAt: "2026-10-30T00:00:01Z", lastPacketAt: "2026-10-30T00:00:03Z" };
  const rows = [1, 2].map(id => ({ requestId: String(id), attemptId: String(id), connectionId: "shared",
    startedAt: "2026-10-30T00:00:00Z", completedAt: "2026-10-30T00:00:02Z" }));
  const match = captureCorrelation(window, rows);
  assert.equal(match.attribution, "TIME_WINDOW_ONLY"); assert.equal(match.candidates.length, 2);
  assert.equal(captureCorrelation({}, rows).attribution, "UNKNOWN");
});
test("SIMULATED_OS_EVENT TCP timeout retains observed attempt duration and leaves TLS unavailable", () => {
  let tick = 0;
  const connection = new ObservedConnection("https://sandboxpgapi.eps.com.bd", true, true, () => ({ wall: new Date(1000 + tick).toISOString(), mono: tick++ }));
  connection.beginTcp("127.0.0.1", 4); connection.endTcp("127.0.0.1", { code: "ETIMEDOUT" }); connection.failed({ code: "ETIMEDOUT" });
  assert.equal(connection.evidence.tcp.status, "FAILED"); assert.equal(connection.evidence.tcp.errorCode, "ETIMEDOUT");
  assert.equal(connection.evidence.tcp.durationMs, 1); assert.equal(connection.evidence.tls.durationMs, null);
  // This tests controlled event handling, not real packet-drop visibility.
});
