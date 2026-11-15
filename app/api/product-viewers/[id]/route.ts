import { NextResponse } from "next/server";
import { touchProductViewer } from "@/lib/product-live-viewers";
import { rateLimitRequest } from "@/lib/request-security";

const VISITOR_ID = /^[A-Za-z0-9-]{8,64}$/;

// Public heartbeat endpoint used by the storefront "people viewing" badge.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const productId = Number(id);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    return NextResponse.json({ error: "Invalid product" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as
    | { visitorId?: unknown; leave?: unknown }
    | null;
  const visitorId = typeof body?.visitorId === "string" ? body.visitorId : "";
  if (!VISITOR_ID.test(visitorId)) {
    return NextResponse.json({ error: "Invalid visitor" }, { status: 400 });
  }

  const limit = await rateLimitRequest(request, {
    scope: "product-viewers",
    limit: 120,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  const viewers = await touchProductViewer(productId, visitorId, body?.leave === true);
  return NextResponse.json({ viewers }, { headers: { "Cache-Control": "no-store" } });
}
