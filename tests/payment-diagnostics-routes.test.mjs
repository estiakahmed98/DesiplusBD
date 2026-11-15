import assert from "node:assert/strict";
import test from "node:test";
import * as crypto from "node:crypto";
import { loadTransportSource as load } from "./helpers/payment-transport-uat.mjs";
function fixture(role = "manager") {
  const domainReads = [];
  const prisma = { user: { findUnique: async () => ({ banned: role === "banned" }) },
    payment: { findFirst: async ({ where }) => { domainReads.push("payment"); return where.id === 25 ? { provider: "EPS" } : null; } },
    paymentDiagnosticCapture: { findMany: async () => { domainReads.push("capture"); return []; } } };
  const requestSecurity = { rateLimitRequest: async () => ({ allowed: true }) };
  const base = load("lib/payment-control/authorization.ts", {
    "server-only": {}, "next/server": { NextResponse: Response },
    "next-auth/next": { getServerSession: async () => role === "anonymous" ? null : { user: { id: "fixture-staff" } } },
    "@/lib/auth": { authOptions: {} }, "@/lib/rbac": { getAccessContext: async user => ({ userId: user?.id ?? null, hasGlobal: key => role === "manager" && key === "settings.payment.manage" }) },
    "@/lib/prisma": { prisma }, "@/lib/request-security": requestSecurity,
    "@/generated/prisma": { Prisma: { PrismaClientKnownRequestError: class extends Error {} } },
  }, { Response });
  const auth = load("lib/payment-control/diagnostic-authorization.ts", { "server-only": {}, "@/lib/prisma": { prisma }, "@/lib/request-security": requestSecurity, "./authorization": base });
  const detail = load("app/api/admin/payment-control/diagnostics/[id]/route.ts", {
    "next/server": { NextResponse: Response }, "node:crypto": crypto,
    "@/lib/payment-control/diagnostic-authorization": auth, "@/lib/payment-control/authorization": base,
    "@/lib/payment-control/investigation": { getPaymentInvestigation: async id => {
      domainReads.push("investigation"); if (id !== 25) throw new base.PaymentControlError("EPS/AIBL payment attempt not found", 404);
      return { version: 2, payment: { id, orderId: 23, provider: "EPS" } };
    } }, "@/lib/payment-control/investigation-report": {},
  }, { Response });
  const captures = load("app/api/admin/payment-control/diagnostics/captures/route.ts", {
    "next/server": { NextResponse: Response }, "@/lib/prisma": { prisma }, "@/lib/payment-control/authorization": base,
    "@/lib/payment-control/diagnostic-authorization": auth, "@/lib/payment-control/capture": { captureProjection: {}, requestCapture() { throw new Error("GET attempted mutation"); } },
    "@/lib/network-monitor/policy": {},
    "@/lib/payment-control/diagnostic-readiness": { diagnosticReadiness: () => ({ capture: { policy: "CAPTURE_DISABLED", authenticationConfigured: false, destinations: {} } }) },
    "@/lib/payment-control/capture-policy": { approvedCaptureIps() { throw new Error("not configured"); }, captureScopeDigest() { throw new Error("unexpected hash"); } },
  }, { Response });
  function request(url) { const value = new Request(url); value.nextUrl = new URL(url); return value; }
  return { domainReads, call(kind, id) {
    return kind === "detail" ? detail.GET(request(`https://fixture.example/api/admin/payment-control/diagnostics/${id}`), { params: Promise.resolve({ id: String(id) }) })
      : captures.GET(request(`https://fixture.example/api/admin/payment-control/diagnostics/captures?paymentId=${id}`));
  } };
}
for (const kind of ["detail", "captures"]) {
  test(`${kind}: authorized global manager receives JSON 200 for an eligible attempt`, async () => {
    const f = fixture(), response = await f.call(kind, 25);
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.json(); assert.equal(kind === "detail" ? body.payment.id : body.jobs.length, kind === "detail" ? 25 : 0);
  });
  for (const [id, status] of [[999, 404], [0, 400], ["invalid", 400]]) test(`${kind}: invalid/missing payment ${id} is application JSON ${status}, not HTML`, async () => {
    const response = await fixture().call(kind, id); assert.equal(response.status, status);
    assert.match(response.headers.get("content-type"), /application\/json/); assert.ok((await response.json()).error);
  });
  for (const [role, status] of [["anonymous", 401], ["warehouse", 403], ["banned", 403]]) test(`${kind}: ${role} is rejected before payment/capture reads`, async () => {
    const f = fixture(role), response = await f.call(kind, 25);
    assert.equal(response.status, status); assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(f.domainReads.length, 0);
  });
}
