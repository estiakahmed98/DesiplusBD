import type { TransportAttemptEvidence } from "./transport-types";
export type PacketAttribution = "REQUEST_ATTRIBUTED" | "CONNECTION_CORRELATED" | "TIME_WINDOW_ONLY" | "UNKNOWN";
// A shared connection UUID cannot be joined to a PCAP TCP stream without an
// observed socket tuple on the same capture host. Overlap is a candidate only.
export function captureCorrelation(window: { firstPacketAt?: unknown; lastPacketAt?: unknown }, attempts: TransportAttemptEvidence[]) {
  const first = typeof window.firstPacketAt === "string" ? Date.parse(window.firstPacketAt) : NaN;
  const last = typeof window.lastPacketAt === "string" ? Date.parse(window.lastPacketAt) : NaN;
  const knownWindow = Number.isFinite(first) && Number.isFinite(last) && last >= first;
  const candidates = knownWindow ? attempts.filter(a => Date.parse(a.startedAt) <= last && Date.parse(a.completedAt) >= first) : [];
  return { attribution: (knownWindow ? "TIME_WINDOW_ONLY" : "UNKNOWN") as PacketAttribution,
    clock: "PCAP_INTERFACE_UTC_NOT_CROSS_HOST_CLOCK_VERIFIED" as const,
    firstPacketAt: knownWindow ? new Date(first).toISOString() : null,
    lastPacketAt: knownWindow ? new Date(last).toISOString() : null,
    candidatesLimited: candidates.length > 100,
    candidates: candidates.slice(0, 100).map(a => ({ requestId: a.requestId, attemptId: a.attemptId, connectionId: a.connectionId })),
    limitation: "Time overlap is not packet ownership. Shared/NAT connections, independent hosts and clock skew prevent exact attribution; request IDs are labels only." };
}
