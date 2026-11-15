import type { DiagnosticCheck } from "./investigation-engine";
export type ConsistencySnapshot = {
  payment: { id: number; status: string; amount: string | null; currency: string; createdAt: string };
  order: { id: number; paymentStatus: string; status: string; amount: string; currency: string };
  settledPayments: number; duplicateBankReferences: number | null; reservations: number;
  stock: Array<{ id: number; kind: string; quantity: number; reserved: number; actualReserved: number }>;
  stockLimited: boolean; verificationRecorded: boolean; settlementRecorded: boolean;
  variantTotals?: Array<{ id: number; storedStock: number; computedStock: number }>;
  commitLedger?: { stockRequired: boolean; observed: boolean; matches: boolean; certainty?: "SNAPSHOT" | "CURRENT_CATALOG" };
  reconciliation: { result: string; createdAt: string } | null;
};
function money(value: string | null): bigint | null {
  if (value === null || !/^\d{1,16}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
// State compatibility only: PASS never substitutes for verification/ledger
// evidence. An old failed attempt can coexist with a later settled attempt.
export function paymentOrderCompatibility(s: Pick<ConsistencySnapshot, "payment" | "order" | "settledPayments">): DiagnosticCheck["status"] {
  const p = s.payment.status, o = s.order.paymentStatus, lifecycle = s.order.status;
  if (!["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED", "FAILED", "REFUNDED"].includes(lifecycle) ||
      !["UNPAID", "PAID", "REFUNDED"].includes(o)) return "UNKNOWN";
  if (p === "CAPTURED") {
    if (o === "UNPAID") return "FAIL";
    if (o === "REFUNDED" || ["CANCELLED", "RETURNED", "FAILED", "REFUNDED"].includes(lifecycle)) return "WARNING";
    return "PASS";
  }
  if (p === "REFUNDED") {
    if (o === "UNPAID") return "FAIL";
    return o === "REFUNDED" && ["CANCELLED", "RETURNED", "REFUNDED"].includes(lifecycle) ? "PASS" : "WARNING";
  }
  if (["INITIATED", "AUTHORIZED"].includes(p)) {
    if (o !== "UNPAID") return "WARNING"; // another attempt or an asynchronous transition
    return ["PENDING", "CONFIRMED"].includes(lifecycle) ? "PASS" : "WARNING";
  }
  if (["FAILED", "VOIDED"].includes(p)) {
    // A count of other settled attempts cannot establish which one explains
    // the order's paid/refunded state or whether its verification was valid.
    if (o !== "UNPAID") return "UNKNOWN";
    return ["PENDING", "CONFIRMED", "CANCELLED", "FAILED"].includes(lifecycle) ? "PASS" : "WARNING";
  }
  return "UNKNOWN";
}
export function checkConsistency(s: ConsistencySnapshot): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const add = (code: string, status: DiagnosticCheck["status"], explanation: string, evidence: string[] = ["database:repeatable-read-snapshot"]) =>
    checks.push({ code, status, explanation, evidence });
  add("PAYMENT_ORDER_CONSISTENCY", paymentOrderCompatibility(s),
    "Applied the documented attempt/order compatibility matrix in one read-only snapshot. PASS validates only state compatibility, not bank verification. WARNING includes legitimate asynchronous/refund transitions requiring review.");
  add("DUPLICATE_PAYMENT", s.settledPayments > 1 ? "FAIL" : "PASS", "Counted CAPTURED/REFUNDED attempts on the same order.");
  add("DUPLICATE_TRANSACTION_REFERENCE", s.duplicateBankReferences === null ? "NOT_OBSERVED" : s.duplicateBankReferences > 0 ? "FAIL" : "PASS",
    "Checked stored provider bank references against other attempts; externalId already has a unique constraint.");
  const a = money(s.payment.amount), b = money(s.order.amount);
  add("PAYMENT_AMOUNT_MISMATCH", a === null || b === null ? "UNKNOWN" : a !== b || s.payment.currency !== s.order.currency ? "FAIL" : "PASS",
    "Compared local attempt and authoritative order amount/currency. This does not claim an echoed gateway amount was observed.");
  add("PAYMENT_VERIFICATION_EVIDENCE", s.verificationRecorded ? "PASS" : "NOT_OBSERVED",
    "Provider-specific successful server verification event or durable verification marker; absence is not proof of unverified capture.");
  add("CONFIRMED_ORDER_WITHOUT_VERIFICATION", s.order.status === "CONFIRMED" && !s.verificationRecorded ? "WARNING" : s.verificationRecorded ? "PASS" : "NOT_OBSERVED",
    "Confirmation without retained verification merits review. Existing workflows can confirm unpaid orders; state alone does not prove an unauthorized modification.");
  add("VERIFIED_WITHOUT_SETTLEMENT", s.verificationRecorded && ["INITIATED", "AUTHORIZED"].includes(s.payment.status) ? "WARNING" :
    s.verificationRecorded ? "PASS" : "NOT_OBSERVED", "Server verification evidence exists while current settlement is pending; compare later events and failed transaction guards.");
  add("INVENTORY_COMMIT_RESERVATIONS", s.payment.status !== "CAPTURED" ? "NOT_OBSERVED" : s.reservations > 0 ? "FAIL" : "PASS",
    "Checked for reservations still attached to an already captured order; does not reconstruct historical commit timing.");
  add("INVENTORY_COMMIT_LEDGER", s.payment.status !== "CAPTURED" || !s.commitLedger ? "NOT_OBSERVED" :
    !s.commitLedger.stockRequired || !s.commitLedger.observed ? "NOT_OBSERVED" :
      s.commitLedger.certainty !== "SNAPSHOT" ? s.commitLedger.matches ? "UNKNOWN" : "WARNING" : s.commitLedger.matches ? "PASS" : "FAIL",
    "Compared provider-specific negative movements with original inventory snapshot where available; otherwise current order/catalog quantities. Catalog changes can explain a mismatch without an original snapshot. Missing historical movement logs remain unobserved.");
  add("NEGATIVE_AVAILABLE_STOCK", s.stock.some(v => v.quantity < 0 || v.reserved < 0 || v.quantity < v.reserved) ? "FAIL" : s.stockLimited ? "UNKNOWN" : !s.stock.length ? "NOT_OBSERVED" : "PASS",
    "Checked related variant and preassembled bundle warehouse levels for negative quantities or availability.");
  add("INVENTORY_RESERVATION_INCONSISTENCY", s.stock.some(v => v.reserved !== v.actualReserved) ? "FAIL" : s.stockLimited ? "UNKNOWN" : !s.stock.length ? "NOT_OBSERVED" : "PASS",
    "Compared each related warehouse reserved counter with the sum of all current reservations, including other orders and carts.");
  add("MULTI_WAREHOUSE_STOCK_MISMATCH", !s.variantTotals ? "NOT_OBSERVED" : s.variantTotals.some(v => v.storedStock !== v.computedStock) ? "FAIL" : s.stockLimited ? "UNKNOWN" : !s.variantTotals.length ? "NOT_OBSERVED" : "PASS",
    "Compared ProductVariant.stock with the sum of non-negative warehouse availability using the existing inventory calculation.");
  add("RECONCILIATION_FAILURE", s.reconciliation && ["CHECK_FAILED", "MISMATCH", "INVALID_REFERENCE", "INVALID_AMOUNT"].includes(s.reconciliation.result) ? "WARNING" :
    s.reconciliation?.result === "MATCH" ? "PASS" : "NOT_OBSERVED", "Latest retained comparison is historical evidence; local state may have changed since it was made.");
  add("UNAUTHORIZED_ADMIN_MODIFICATION", "UNKNOWN", "Current financial state cannot prove who changed it; review existing ActivityLog and database audit records.");
  add("INVALID_STATUS_TRANSITION", "NOT_OBSERVED", "No authoritative before/after transition ledger was supplied; current state alone does not establish an invalid transition.");
  return checks;
}
