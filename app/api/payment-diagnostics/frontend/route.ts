import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { verifyPaymentInitToken } from "@/lib/sslcommerz";
import { rateLimitRequest } from "@/lib/request-security";
import { readMonitorBody } from "@/lib/network-monitor/policy";
import { isFrontendDiagnosticOriginAllowed } from "@/lib/payment-control/frontend-origin";
import { diagnosticsEnabled, frontendDiagnosticCodes, type FrontendDiagnosticCode } from "@/lib/payment-control/diagnostic-policy";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!diagnosticsEnabled()) return new Response(null, { status: 204, headers });
  if (process.env.PAYMENT_CONTROL_LOGGING_ENABLED === "false") return new Response(null, { status: 503, headers });
  try {
    if (!isFrontendDiagnosticOriginAllowed(request)) return new Response(null, {
      status: 403, headers: { ...headers, "X-Payment-Diagnostic-Reason": "ORIGIN_REJECTED" },
    });
    const limit = await rateLimitRequest(request, { scope: "payment-browser-diagnostics", limit: 30, windowMs: 60000 });
    if (!limit.allowed) return new Response(null, { status: 429, headers });
    const body = await readMonitorBody(request);
    if (typeof body.orderId !== "number" || !Number.isSafeInteger(body.orderId) || body.orderId < 1 ||
      !frontendDiagnosticCodes.includes(body.code as FrontendDiagnosticCode) || typeof body.durationMs !== "number" ||
      !Number.isSafeInteger(body.durationMs) || body.durationMs < 0 || body.durationMs > 120000) return new Response(null, { status: 400, headers });
    const session = await getServerSession(authOptions);
    const order = await prisma.order.findUnique({ where: { id: body.orderId }, select: { id: true, userId: true, payment_method: true } });
    const userId = (session?.user as { id?: string } | undefined)?.id;
    if (!order || !(order.userId ? order.userId === userId : verifyPaymentInitToken(order.id, body.paymentInitToken)))
      return new Response(null, { status: 403, headers: { ...headers, "X-Payment-Diagnostic-Reason": "OWNERSHIP_REJECTED" } });
    const provider = order.payment_method.startsWith("EPS:") ? "EPS" : order.payment_method.startsWith("AIBL_WALLET:") ? "AIBL_WALLET" : null;
    if (!provider) return new Response(null, { status: 400, headers });
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (body.paymentId !== undefined || body.requestId != null && (typeof body.requestId !== "string" || !uuid.test(body.requestId)) ||
      body.reportId !== undefined && (typeof body.reportId !== "string" || !uuid.test(body.reportId))) return new Response(null, { status: 400, headers });
    const requestId = typeof body.requestId === "string" ? body.requestId.toLowerCase() : undefined;
    // An arbitrary client-supplied UUID is never trusted as a server request ID.
    const serverScope = { requestId, orderId: order.id, provider, operation: { not: "FRONTEND" } };
    // Prefer an actual attempt over earlier AUTH/initiator events with null IDs.
    // The relation also verifies that the attempt belongs to this order/provider.
    const bound = requestId ? await prisma.paymentEvent.findFirst({ where: { ...serverScope, paymentId: { not: null },
      payment: { orderId: order.id, provider } }, select: { paymentId: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }) : null;
    if (requestId && !bound && !await prisma.paymentEvent.findFirst({ where: serverScope, select: { id: true } }))
      return new Response(null, { status: 400, headers });
    // One code per verified server request; order-only submissions use a client
    // report nonce. A primary-key conflict is safe under concurrent deliveries.
    // Legacy clients without a nonce are deduplicated per order/code/minute.
    const nonce = requestId ?? body.reportId ?? Math.floor(Date.now() / 60000);
    const id = "browser_" + createHash("sha256").update(JSON.stringify([provider, order.id, nonce, body.code])).digest("hex");
    await prisma.paymentEvent.createMany({ data: [{ id, provider, orderId: order.id, paymentId: bound?.paymentId ?? null,
      requestId: requestId ?? null, operation: "FRONTEND", outcome: "RECEIVED",
      detailCode: body.code as FrontendDiagnosticCode, durationMs: body.durationMs }], skipDuplicates: true });
    return new Response(null, { status: 204, headers });
  } catch { return NextResponse.json({ error: "Diagnostic report unavailable" }, { status: 503, headers }); }
}
