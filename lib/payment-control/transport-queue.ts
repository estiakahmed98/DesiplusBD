import type { TransportAttemptEvidence } from "./transport-types";

export type TransportQueueCounters = { accepted: number; persisted: number; duplicates: number; dropped: number;
  rejected: number; sanitizerErrors: number; writeErrors: number; drainErrors: number;
  retries: number; recovered: number; permanentFailures: number; retryExhausted: number };
type Dependencies = {
  sanitize: (input: unknown) => TransportAttemptEvidence | null;
  write: (input: TransportAttemptEvidence) => Promise<"INSERTED" | "DUPLICATE">;
  schedule: (task: () => void) => unknown;
  delay?: (ms: number) => Promise<void>;
};
export const MAX_QUEUED = 128;
// Fixed allowlist, no messages or raw errors are retained. Missing tables,
// invalid data and auth errors are permanent; unknown failures fail closed.
export function retryableTransportWrite(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const source = error as { code?: unknown; meta?: { code?: unknown } };
  return ["P1001", "P1002", "P1008", "P1017", "P2024", "P2034", "40001", "40P01", "55P03", "57014", "08006", "08001", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"].includes(String(source.code)) ||
    source.code === "P2010" && ["40001", "40P01", "55P03", "57014", "08006"].includes(String(source.meta?.code));
}
export class TransportEvidenceQueue {
  private queue: TransportAttemptEvidence[] = [];
  private running = false;
  private inFlight = false;
  private generation: symbol | null = null;
  private pending: Promise<void> = Promise.resolve();
  private counters: TransportQueueCounters = { accepted: 0, persisted: 0, duplicates: 0, dropped: 0,
    rejected: 0, sanitizerErrors: 0, writeErrors: 0, drainErrors: 0,
    retries: 0, recovered: 0, permanentFailures: 0, retryExhausted: 0 };
  private lastFailureAt: string | null = null;
  private lastPersistedAt: string | null = null;
  constructor(private readonly dependencies: Dependencies) {}
  private count(key: keyof TransportQueueCounters, amount = 1) {
    this.counters[key] = Math.min(Number.MAX_SAFE_INTEGER, this.counters[key] + Math.max(0, amount));
  }
  enqueue(inputs: readonly unknown[]) {
    try {
      if (!Array.isArray(inputs)) { this.count("rejected"); return; }
      this.count("dropped", Math.max(0, inputs.length - 8));
      for (const input of inputs.slice(0, 8)) {
        if (this.queue.length + Number(this.inFlight) >= MAX_QUEUED) { this.count("dropped"); continue; }
        try {
          const safe = this.dependencies.sanitize(input);
          if (!safe) { this.count("rejected"); continue; }
          this.queue.push(safe);
          this.count("accepted");
        } catch { this.count("sanitizerErrors"); this.count("rejected"); }
      }
      this.start();
    } catch { this.count("drainErrors"); }
  }
  private start() {
    if (this.running || !this.queue.length) return;
    this.running = true;
    const generation = this.generation = Symbol();
    try {
      this.dependencies.schedule(() => {
        if (this.generation !== generation) return;
        // Catch even an unexpected rejection outside the ordinary write handler.
        this.pending = Promise.resolve().then(() => this.drain(generation))
          .catch(() => this.recover(generation, true));
      });
    } catch { this.recover(generation, true); }
  }
  private recover(generation: symbol, unexpected: boolean) {
    if (this.generation !== generation) return;
    if (unexpected) this.count("drainErrors");
    this.count("dropped", this.queue.length + (this.inFlight ? 1 : 0));
    this.queue.length = 0;
    this.inFlight = false;
    this.running = false;
    this.generation = null;
  }
  private async drain(generation: symbol) {
    try {
      while (this.generation === generation && this.queue.length) {
        const attempt = this.queue.shift()!;
        this.inFlight = true;
        for (let retry = 0; retry <= 2; retry++) {
          try {
            const outcome = await this.dependencies.write(attempt);
            if (this.generation !== generation) return;
            if (outcome !== "INSERTED" && outcome !== "DUPLICATE") throw new Error("INVALID_TRANSPORT_WRITE_RESULT");
            this.count(outcome === "DUPLICATE" ? "duplicates" : "persisted");
            if (retry) this.count("recovered");
            this.lastPersistedAt = new Date().toISOString();
            break;
          } catch (error) {
            this.count("writeErrors"); this.lastFailureAt = new Date().toISOString();
            if (!retryableTransportWrite(error) || retry === 2) {
              this.count(retryableTransportWrite(error) ? "retryExhausted" : "permanentFailures");
              this.count("dropped"); break;
            }
            this.count("retries");
            await (this.dependencies.delay ?? (ms => new Promise<void>(accept => setTimeout(accept, ms))))(retry === 0 ? 250 : 1000);
          }
        }
        this.inFlight = false;
      }
    } catch {
      this.recover(generation, true);
    } finally {
      if (this.generation === generation) { this.running = false; this.inFlight = false; }
    }
  }
  snapshot() {
    return { ...this.counters, queueDepth: this.queue.length, inFlight: this.inFlight,
      lastFailureAt: this.lastFailureAt, lastPersistedAt: this.lastPersistedAt,
      evidenceGap: this.counters.dropped > 0, durability: "MEMORY_ONLY_LOST_ON_PROCESS_EXIT" as const,
      scope: "CURRENT_PROCESS_ONLY" as const, completeness: "BEST_EFFORT_NOT_GUARANTEED" as const };
  }
  // Deterministic offline scheduling tests can await the currently running batch.
  waitForIdle() { return this.pending; }
}
