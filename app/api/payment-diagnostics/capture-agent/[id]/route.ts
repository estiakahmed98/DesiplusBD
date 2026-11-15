import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCaptureAgent } from "@/lib/payment-control/capture";
import { approvedCaptureIps, captureScopeDigest, type CaptureProvider } from "@/lib/payment-control/capture-policy";
import { saveCaptureEvidence, deleteCaptureEvidence } from "@/lib/payment-control/capture-storage";
import { PaymentControlError, paymentControlErrorResponse } from "@/lib/payment-control/authorization";
import { rateLimitRequest } from "@/lib/request-security";
export const runtime = "nodejs";
const errors = new Set(["CAPTURE_PROCESS_FAILED", "CAPTURE_TIMEOUT", "CAPTURE_SIZE_LIMIT", "CAPTURE_INVALID_FILE", "CAPTURE_PERMISSION_FAILED",
  "CAPTURE_INTERFACE_UNAVAILABLE", "CAPTURE_TOOL_UNAVAILABLE", "CAPTURE_ABORTED", "CAPTURE_ANALYSIS_FAILED"]);
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  let ownedId: string | undefined;
  try {
    const agentId = await requireCaptureAgent(request);
    const limit = await rateLimitRequest(request, { scope: "capture-agent-result", identifier: agentId, limit: 20, windowMs: 60000 });
    if (!limit.allowed) throw new PaymentControlError("Result rate limit exceeded", 429);
    const { id } = await context.params;
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new PaymentControlError("Invalid capture ID");
    const job = await prisma.paymentDiagnosticCapture.findFirst({ where: { id, agentId, status: "RUNNING",
      expiresAt: { gt: new Date() }, startedAt: { gt: new Date(Date.now() - 120000) } } });
    if (!job) throw new PaymentControlError("Capture lease is unavailable", 409);
    const suppliedError = request.headers.get("x-capture-error");
    if (suppliedError) {
      if (!errors.has(suppliedError)) throw new PaymentControlError("Invalid capture error code");
      await prisma.paymentDiagnosticCapture.updateMany({ where: { id, agentId, status: "RUNNING" },
        data: { status: "FAILED", errorCode: suppliedError, completedAt: new Date() } });
      return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
    }
    if (request.headers.get("content-type") !== "application/x-pcapng") throw new PaymentControlError("PCAPNG required");
    const claim = await prisma.paymentDiagnosticCapture.updateMany({ where: { id, agentId, status: "RUNNING" }, data: { status: "UPLOADING" } });
    if (claim.count !== 1) throw new PaymentControlError("Capture already submitted", 409);
    ownedId = id;
    const reader = request.body?.getReader();
    if (!reader) throw new PaymentControlError("Capture file required");
    const chunks: Buffer[] = []; let bytes = 0;
    const deadline = Date.now() + 10000;
    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new PaymentControlError("Capture upload deadline exceeded", 408)); }, Math.max(1, deadline - Date.now()));
        })]).finally(() => clearTimeout(timer));
        if (Date.now() > deadline) throw new PaymentControlError("Capture upload deadline exceeded", 408);
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > job.maxBytes) { await reader.cancel(); throw new PaymentControlError("Capture exceeds size limit", 413); }
        chunks.push(Buffer.from(result.value));
      }
    } finally { reader.releaseLock(); }
    const safe = await saveCaptureEvidence(id, Buffer.concat(chunks), approvedCaptureIps(job.provider as CaptureProvider));
    const retransmissions = Number(request.headers.get("x-capture-retransmissions"));
    if (!Number.isSafeInteger(retransmissions) || retransmissions < 0 || retransmissions > safe.packetCount) throw new PaymentControlError("Invalid packet analysis");
    if (job.kind === "READINESS") await deleteCaptureEvidence(id);
    // Completion must still own the lease. A janitor/expiry transition must not
    // be resurrected by an upload that arrived after its capture window.
    const completed = await prisma.paymentDiagnosticCapture.updateMany({ where: { id, agentId, status: "UPLOADING",
      expiresAt: { gt: new Date() }, startedAt: { gt: new Date(Date.now() - 120000) } }, data: { status: "COMPLETE", completedAt: new Date(),
      packetCount: safe.packetCount, bytes: job.kind === "READINESS" ? null : safe.bytes,
      sha256: job.kind === "READINESS" ? null : safe.sha256,
      summary: { payloadPolicy: safe.payloadPolicy, resets: safe.resets, retransmissions,
        approvedScopeSha256: captureScopeDigest(job.provider, approvedCaptureIps(job.provider as CaptureProvider)),
        analysisSource: "AUTHENTICATED_AGENT_TSHARK", attribution: "TIME_WINDOW_ONLY",
        attributionBasis: "APPROVED_DESTINATION_AND_CAPTURE_WINDOW_REQUEST_ID_IS_LABEL_ONLY",
        firstPacketAt: safe.firstPacketAt, lastPacketAt: safe.lastPacketAt, checksumPolicy: safe.checksumPolicy,
        integrity: "SHA256_OF_DERIVED_SANITIZED_FILE_NOT_SIGNED",
        readiness: "INTERFACE_OPENED_AND_PCAPNG_VALIDATED", trafficObserved: safe.packetCount > 0 } } });
    if (completed.count !== 1) throw new PaymentControlError("Capture lease expired before completion", 409);
    return NextResponse.json({ packetCount: safe.packetCount, sha256: job.kind === "READINESS" ? null : safe.sha256 },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (ownedId) {
      await deleteCaptureEvidence(ownedId).catch(() => {});
      await prisma.paymentDiagnosticCapture.updateMany({ where: { id: ownedId, status: "UPLOADING" },
        data: { status: "FAILED", errorCode: "CAPTURE_INVALID_FILE", completedAt: new Date() } }).catch(() => {});
    }
    return paymentControlErrorResponse(error);
  }
}
