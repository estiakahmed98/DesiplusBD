import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { positiveId, paymentControlErrorResponse, PaymentControlError } from "@/lib/payment-control/authorization";
import { requireDiagnosticAccess } from "@/lib/payment-control/diagnostic-authorization";
import { captureProjection, requestCapture } from "@/lib/payment-control/capture";
import { readMonitorBody } from "@/lib/network-monitor/policy";
import { diagnosticReadiness } from "@/lib/payment-control/diagnostic-readiness";
import { captureScopeDigest, approvedCaptureIps, type CaptureProvider } from "@/lib/payment-control/capture-policy";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    await requireDiagnosticAccess(request);
    const paymentId = positiveId(request.nextUrl.searchParams.get("paymentId"));
    const [jobs, agent, payment] = await Promise.all([
      prisma.paymentDiagnosticCapture.findMany({ where: { paymentId, expiresAt: { gt: new Date() } },
        select: captureProjection, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 }),
      process.env.PAYMENT_CAPTURE_AGENT_ID ? prisma.networkMonitorAgent.findUnique({ where: { id: process.env.PAYMENT_CAPTURE_AGENT_ID },
        select: { lastSeenAt: true } }) : null,
      prisma.payment.findFirst({ where: { id: paymentId, provider: { in: ["EPS", "AIBL_WALLET"] }, orderId: { not: null } }, select: { provider: true } }),
    ]);
    if (!payment) throw new PaymentControlError("EPS/AIBL payment attempt not found", 404);
    const configuration = diagnosticReadiness();
    let scopeDigest: string | null = null;
    try { scopeDigest = captureScopeDigest(payment.provider!, approvedCaptureIps(payment.provider as CaptureProvider)); } catch { /* Invalid current policy cannot have ready capture status. */ }
    const readiness = jobs.find(job => job.kind === "READINESS" && job.status === "COMPLETE" && job.completedAt &&
      job.agentId === process.env.PAYMENT_CAPTURE_AGENT_ID && Date.now() - job.completedAt.getTime() < 300000 &&
      scopeDigest && job.summary && typeof job.summary === "object" && !Array.isArray(job.summary) && job.summary.approvedScopeSha256 === scopeDigest);
    return NextResponse.json({ jobs, agent: { configured: Boolean(process.env.PAYMENT_CAPTURE_AGENT_ID),
      lastSeenAt: agent?.lastSeenAt ?? null, status: agent?.lastSeenAt && Date.now() - agent.lastSeenAt.getTime() < 60000 ? "ONLINE" : "NOT_OBSERVED" },
      readiness: { scope: "THIS_ATTEMPT_LATEST_50_JOBS", status: readiness ? readiness.packetCount && readiness.packetCount > 0 ? "SCOPED_TRAFFIC_OBSERVED" : "INTERFACE_READY_NO_SCOPED_TRAFFIC" : "NOT_OBSERVED_OR_EXPIRED",
        heartbeatProvesPacketVisibility: false },
      enabled: configuration.capture.policy === "READY_CONFIGURATION_ONLY" && configuration.capture.authenticationConfigured &&
        configuration.capture.destinations[payment.provider as "EPS" | "AIBL_WALLET"] === "OPERATOR_APPROVED_CONFIGURATION" },
    { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return paymentControlErrorResponse(error); }
}
export async function POST(request: NextRequest) {
  try {
    const access = await requireDiagnosticAccess(request, "payments.diagnostics.capture", true);
    return NextResponse.json(await requestCapture(await readMonitorBody(request), access.userId!),
      { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return paymentControlErrorResponse(error); }
}
