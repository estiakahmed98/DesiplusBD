import assert from "node:assert/strict";
import test from "node:test";
import * as crypto from "node:crypto";
import { loadTransportSource as load } from "./helpers/payment-transport-uat.mjs";

const publicOrigin = "https://crawling-gauging-supernova.ngrok-free.dev";
const internalUrl = "https://localhost:3000/api/payment-diagnostics/frontend";
const originModule = () => load("lib/payment-control/frontend-origin.ts", {}, { URL });
// Load the real signing/verifying functions with an isolated secret. All payment
// dependencies are inert; this suite never imports the app or connects to a DB.
const tokens = load("lib/sslcommerz.ts", {
  crypto, "@/lib/prisma": {}, "@/generated/prisma": {},
  "@/lib/business-network/commission": {}, "@/lib/inventory": {},
  "@/lib/order-inventory-lifecycle": {}, "@/lib/order-admin-notifications": {},
  "@/lib/payment-control/telemetry": {}, "@/lib/payment-control/gateway-query": {},
}, { process: { env: { NEXTAUTH_SECRET: "isolated-test-signing-secret-not-an-app-secret" } } });

function fixture({ user = "owner", owner = "owner", allowed = true, env = { NEXT_PUBLIC_APP_URL: publicOrigin } } = {}) {
  const calls = { limit: 0, body: 0, session: 0, order: 0, event: 0, writes: [] };
  const route = load("app/api/payment-diagnostics/frontend/route.ts", {
    "next/server": { NextResponse: Response }, "node:crypto": crypto,
    "next-auth/next": { getServerSession: async () => { calls.session++; return user ? { user: { id: user } } : null; } },
    "@/lib/auth": { authOptions: {} },
    "@/lib/prisma": { prisma: {
      order: { findUnique: async ({ where }) => { calls.order++; return where.id === 7 ? { id: 7, userId: owner, payment_method: "EPS:1" } : null; } },
      paymentEvent: { findFirst: async () => { calls.event++; return null; },
        createMany: async ({ data }) => { calls.writes.push(...data); return { count: data.length }; } },
    } },
    "@/lib/sslcommerz": tokens,
    "@/lib/request-security": { rateLimitRequest: async () => { calls.limit++; return { allowed }; } },
    "@/lib/network-monitor/policy": { readMonitorBody: async request => { calls.body++; return request.json(); } },
    "@/lib/payment-control/diagnostic-policy": { diagnosticsEnabled: () => true, frontendDiagnosticCodes: ["FRONTEND_API_FAILED"] },
    // Lazy wrapper also lets the before-fix test execute the unchanged route.
    "@/lib/payment-control/frontend-origin": { isFrontendDiagnosticOriginAllowed: request => originModule().isFrontendDiagnosticOriginAllowed(request, env) },
  }, { Response, URL, process: { env } });
  const send = ({ origin = publicOrigin, url = internalUrl, headers = {}, body = {} } = {}) => route.POST(new Request(url, {
    method: "POST", headers: { ...(origin === null ? {} : { origin }), "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify({ orderId: 7, code: "FRONTEND_API_FAILED", durationMs: 20, ...body }),
  }));
  return { send, calls };
}

test("ngrok public Origin differs from Next internal URL: configured owner report succeeds", async () => {
  assert.notEqual(new URL(internalUrl).origin, publicOrigin);
  const f = fixture(), response = await f.send();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(f.calls.session, 1); assert.equal(f.calls.writes.length, 1);
});

for (const [name, options] of [
  ["foreign Origin and forged forwarded headers", { origin: "https://attacker.example", headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https", forwarded: "host=attacker.example;proto=https", host: "attacker.example" } }],
  ["missing Origin despite same-origin fetch metadata", { origin: null }],
  ["opaque Origin", { origin: "null" }],
  ["Origin containing a path", { origin: publicOrigin + "/checkout" }],
  ["suffix lookalike", { origin: publicOrigin + ".attacker.example" }],
  ["different scheme", { origin: publicOrigin.replace("https:", "http:") }],
  ["different port", { origin: publicOrigin + ":444" }],
  ["multiple Origins", { origin: publicOrigin + ", https://attacker.example" }],
  ["cross-site Fetch Metadata even with trusted Origin", { headers: { "sec-fetch-site": "cross-site" } }],
  ["same-site subdomain Fetch Metadata", { headers: { "sec-fetch-site": "same-site" } }],
]) test(`origin fails closed: ${name}`, async () => {
  const f = fixture(), response = await f.send(options);
  assert.equal(response.status, 403); assert.equal(response.headers.get("x-payment-diagnostic-reason"), "ORIGIN_REJECTED");
  assert.deepEqual(f.calls, { limit: 0, body: 0, session: 0, order: 0, event: 0, writes: [] });
  assert.equal(await response.text(), "");
});

for (const [name, setup, body] of [
  ["missing session", { user: null }, {}],
  ["another customer's session", { user: "other" }, {}],
  ["missing order", {}, { orderId: 999 }],
  ["guest missing token", { user: null, owner: null }, {}],
  ["guest tampered token", { user: null, owner: null }, { paymentInitToken: tokens.createPaymentInitToken(7) + "x" }],
  ["guest expired token", { user: null, owner: null }, { paymentInitToken: tokens.createPaymentInitToken(7, -1) }],
  ["guest token bound to a different order", { user: null, owner: null }, { paymentInitToken: tokens.createPaymentInitToken(8) }],
  ["guest token cannot authorize a registered customer's order", { user: null }, { paymentInitToken: tokens.createPaymentInitToken(7) }],
]) test(`ownership remains enforced through tunnel: ${name}`, async () => {
  const f = fixture(setup), response = await f.send({ body });
  assert.equal(response.status, 403); assert.equal(response.headers.get("x-payment-diagnostic-reason"), "OWNERSHIP_REJECTED");
  assert.equal(f.calls.event, 0); assert.equal(f.calls.writes.length, 0);
});

test("guest with real valid order-bound signed token succeeds through tunnel", async () => {
  const f = fixture({ user: null, owner: null });
  assert.equal((await f.send({ body: { paymentInitToken: tokens.createPaymentInitToken(7) } })).status, 204);
  assert.equal(f.calls.writes.length, 1);
  assert.equal("paymentInitToken" in f.calls.writes[0], false);
});
test("rate limit precedes session and ownership reads through tunnel", async () => {
  const f = fixture({ allowed: false }); assert.equal((await f.send()).status, 429);
  assert.equal(f.calls.order, 0); assert.equal(f.calls.session, 0); assert.equal(f.calls.writes.length, 0);
});
test("client-supplied payment ID and unbound server request remain rejected", async () => {
  for (const body of [{ paymentId: 999 }, { requestId: "11111111-1111-4111-8111-111111111111" }]) {
    const f = fixture(); assert.equal((await f.send({ body })).status, 400); assert.equal(f.calls.writes.length, 0);
  }
});
test("direct localhost reports retain same-origin support without public configuration", async () => {
  const f = fixture({ env: {} });
  assert.equal((await f.send({ url: internalUrl, origin: new URL(internalUrl).origin })).status, 204);
  assert.equal((await f.send({ headers: { "x-forwarded-host": new URL(publicOrigin).host, "x-forwarded-proto": "https" } })).status, 403);
});

test("proxy passes collector to its own session/guest authorization without RBAC interception", async () => {
  let sessionFetches = 0;
  const proxy = load("proxy.ts", {
    "next/server": { NextResponse: { next: () => new Response(null, { status: 204 }) } },
    "@/lib/dashboard-route": {},
  }, { Response, fetch: async () => { sessionFetches++; throw new Error("Unexpected proxy session fetch"); } });
  const req = new Request(internalUrl, { method: "POST" }); req.nextUrl = new URL(internalUrl);
  assert.equal((await proxy.default(req)).status, 204); assert.equal(sessionFetches, 0);
});

for (const key of ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_BASE_URL", "NEXT_PUBLIC_SITE_URL", "APP_URL", "NEXTAUTH_URL"]) {
  test(`explicit server configuration ${key} supports the public origin`, () => {
    const request = new Request(internalUrl, { headers: { origin: publicOrigin } });
    assert.equal(originModule().isFrontendDiagnosticOriginAllowed(request, { [key]: publicOrigin + "/" }), true);
  });
}
for (const configured of ["not-a-url", "https://user:password@example.com", publicOrigin + "/checkout", publicOrigin + "?q=private", publicOrigin + "#fragment", "ftp://example.com", "*"]) {
  test(`malformed/non-origin configuration is rejected: ${configured.replace(/user:password/, "REDACTED")}`, () => {
    const request = new Request(internalUrl, { headers: { origin: publicOrigin } });
    assert.equal(originModule().isFrontendDiagnosticOriginAllowed(request, { NEXT_PUBLIC_APP_URL: configured }), false);
  });
}
test("primary app origin takes precedence over a different auth origin", () => {
  const request = new Request(internalUrl, { headers: { origin: publicOrigin } });
  assert.equal(originModule().isFrontendDiagnosticOriginAllowed(request, { NEXT_PUBLIC_APP_URL: "https://shop.example", NEXTAUTH_URL: publicOrigin }), false);
});
