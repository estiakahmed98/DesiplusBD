"use client";
import type { FrontendDiagnosticCode } from "./diagnostic-policy";
type Context = { orderId: number; paymentInitToken?: string | null };
// No customer fields, URLs, errors, credentials or browser fingerprint are sent.
// This best-effort side request never delays checkout or retries a charge.
function report(context: Context, code: FrontendDiagnosticCode, requestId: string | null, durationMs: number) {
  try {
    if (process.env.NEXT_PUBLIC_PAYMENT_DIAGNOSTICS_ENABLED !== "true") return;
    // randomUUID may be unavailable on an HTTP LAN development origin. The
    // nonce is a dedup hint, never authorization; server has a bounded fallback.
    const reportId = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : undefined;
    void fetch("/api/payment-diagnostics/frontend", { method: "POST", keepalive: true,
      headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      // Navigation must not abort an otherwise valid keepalive side request.
      // The body is a few hundred bytes, well below the browser's shared quota.
      body: JSON.stringify({ reportId, orderId: context.orderId, paymentInitToken: context.paymentInitToken, code, requestId,
        durationMs: Math.min(120000, Math.max(0, Math.round(durationMs))) }) }).catch(() => {});
  } catch { /* Never affect the checkout result. */ }
}
export async function diagnosticPaymentFetch(input: string, init: RequestInit, context: Context) {
  const start = performance.now();
  try {
    const response = await fetch(input, init);
    report(context, response.ok ? "FRONTEND_VALIDATION_PASSED" : "FRONTEND_API_FAILED",
      response.headers.get("X-Payment-Request-Id"), performance.now() - start);
    return response;
  } catch (error) {
    report(context, "FRONTEND_NETWORK_INTERRUPTED", null, performance.now() - start);
    throw error;
  }
}
export function diagnosticPaymentRedirect(url: string, response: Response, context: Context) {
  const requestId = response.headers.get("X-Payment-Request-Id");
  try {
    report(context, "FRONTEND_REDIRECT_REQUESTED", requestId, 0);
    window.location.href = url;
  } catch (error) {
    report(context, "FRONTEND_REDIRECT_FAILED", requestId, 0);
    throw error;
  }
}
