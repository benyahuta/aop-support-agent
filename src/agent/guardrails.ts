// Policy-as-code. Every tool call passes through checkToolCall before it runs,
// and every reply passes through filterReply before the customer sees it.
//
// The model is told these rules in the AOPs too, but a rule that lives only in
// a prompt can be talked out of (see the prompt-injection evals). These checks
// run in ordinary code with the backend's real data, so they hold no matter
// what the model was persuaded to attempt.
import type { CompiledAop } from "../aop/compiler.ts";
import { GLOBAL_TOOLS } from "../aop/compiler.ts";
import type { AgentConfig } from "../config.ts";
import { round } from "../db/world.ts";
import type { Session } from "./session.ts";
import { daysBetween, MUTATING } from "./tools.ts";

export type Verdict =
  | { decision: "allow" }
  | { decision: "require_approval"; rule: string; detail: string }
  | { decision: "block"; rule: string; detail: string };

const ORDER_SCOPED = new Set(["lookup_order", "track_shipment", "issue_refund", "create_return", "cancel_order", "update_shipping_address"]);
const RETURN_WINDOW_DAYS = 30;

const block = (rule: string, detail: string): Verdict => ({ decision: "block", rule, detail });

export function checkToolCall(session: Session, aops: Map<string, CompiledAop>, cfg: AgentConfig, name: string, input: any): Verdict {
  const w = session.world;

  // 1. Procedure scope: action tools only run inside a loaded procedure that lists them.
  if (!GLOBAL_TOOLS.includes(name)) {
    const aop = session.activeAop ? aops.get(session.activeAop) : undefined;
    if (!aop) return block("procedure_scope", `No procedure is loaded. Call load_procedure before using ${name}.`);
    if (!aop.tools.includes(name)) return block("procedure_scope", `${name} is not part of procedure ${aop.id}. Load the procedure that covers this request.`);
  }

  // 2. Verification lockout.
  if (name === "verify_identity" && session.failedVerifications >= cfg.maxVerificationAttempts) {
    return block("verification_lockout", "Too many failed verification attempts. Do not try again; escalate_to_human with reason verification_failed.");
  }

  // 3. Identity + ownership for anything that touches a specific order or account.
  if (ORDER_SCOPED.has(name) || name === "list_customer_orders") {
    if (!session.verifiedCustomerId) return block("identity_required", "The customer is not verified. Ask for their order number and checkout email and call verify_identity first.");
  }
  if (ORDER_SCOPED.has(name)) {
    const order = w.order(String(input.order_id));
    if (!order) return block("order_not_found", `No order ${input.order_id} exists.`);
    if (order.customer_id !== session.verifiedCustomerId) {
      return block("order_ownership", "That order does not belong to the verified customer. Do not share any details about it.");
    }
    if (MUTATING.has(name) && !session.lookedUp.has(order.id)) {
      return block("lookup_before_action", `Call lookup_order for ${order.id} and review it with the customer before changing anything.`);
    }

    const now = w.now();
    switch (name) {
      case "cancel_order":
        if (order.status !== "processing") return block("cancel_requires_processing", `Order is ${order.status}; only processing orders can be cancelled.`);
        break;
      case "update_shipping_address":
        if (order.status !== "processing") return block("address_requires_processing", `Order is ${order.status}; the address can only change before it ships.`);
        break;
      case "create_return": {
        if (order.status !== "delivered" || !order.delivered_at) return block("return_requires_delivery", "Returns can only be started after delivery.");
        if (daysBetween(order.delivered_at, now) > RETURN_WINDOW_DAYS) return block("return_window", `Delivered ${daysBetween(order.delivered_at, now)} days ago; the return window is ${RETURN_WINDOW_DAYS} days.`);
        const item = w.items(order.id).find((i) => i.sku.toUpperCase() === String(input.sku).toUpperCase());
        if (!item) return block("return_unknown_item", `SKU ${input.sku} is not on order ${order.id}.`);
        if (item.final_sale) return block("final_sale", `${item.name} is final sale and can't be returned for change of mind.`);
        if (w.returns().some((r) => r.order_id === order.id && r.sku === item.sku)) return block("duplicate_return", "A return already exists for this item.");
        break;
      }
      case "issue_refund": {
        const amount = Number(input.amount);
        const remaining = round(order.total - order.refunded_amount - pendingFor(session, order.id));
        if (input.reason === "lost_package") {
          const s = w.shipment(order.id);
          const late = s ? daysBetween(s.eta, now) : 0;
          const lost = s && s.status !== "delivered" && (s.status === "stalled" || late > 5);
          if (!lost) return block("lost_package_unconfirmed", "Tracking does not show this package as lost.");
        } else {
          if (order.status !== "delivered" || !order.delivered_at) return block("refund_requires_delivery", "Damaged/defective/wrong-item refunds require a delivered order.");
          const days = daysBetween(order.delivered_at, now);
          if (days > RETURN_WINDOW_DAYS) return block("refund_window", `Delivered ${days} days ago; damage claims must be within ${RETURN_WINDOW_DAYS} days. Offer escalation for an exception review.`);
        }
        if (remaining <= 0) return block("already_refunded", "This order has already been fully refunded.");
        if (amount > remaining + 0.001) return block("refund_exceeds_paid", `Requested $${amount} but only $${remaining} is refundable on this order.`);
        // Approval threshold applies to the session total, so a large refund
        // can't be split into several small ones that each pass.
        if (round(session.autoRefunded + amount) > cfg.autoRefundLimit) {
          return { decision: "require_approval", rule: "refund_auto_limit", detail: `$${round(session.autoRefunded + amount)} in refunds this conversation exceeds the $${cfg.autoRefundLimit} automatic limit; queued for human approval.` };
        }
        break;
      }
    }
  }
  return { decision: "allow" };
}

function pendingFor(session: Session, orderId: string): number {
  return session.world.refunds(orderId).filter((r) => r.status === "pending_approval").reduce((s, r) => s + r.amount, 0);
}

// --- output filter ------------------------------------------------------------

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /\b\d{3}-\d{4}\b/g;
const ORDER = /\bLP-\d{3,}\b/gi;

/**
 * Redact identifiers in the reply that belong to someone other than the
 * verified customer and that the customer didn't type themselves. Catches
 * cross-account leaks even if every upstream check were somehow bypassed.
 */
export function filterReply(session: Session, text: string): { text: string; redactions: string[] } {
  const w = session.world;
  const typed = session.customerText.toLowerCase();
  const own = session.verifiedCustomerId ? w.customer(session.verifiedCustomerId) : undefined;
  const ownOrders = new Set(own ? w.ordersFor(own.id).map((o) => o.id) : []);
  const redactions: string[] = [];

  const scrub = (re: RegExp, isAllowed: (m: string) => boolean, known: (m: string) => boolean) =>
    (s: string) => s.replace(re, (m) => {
      if (typed.includes(m.toLowerCase()) || isAllowed(m) || !known(m)) return m;
      redactions.push(m);
      return "[redacted]";
    });

  const emails = new Set(allCustomers(session).map((c) => c.email.toLowerCase()));
  const phones = new Set(allCustomers(session).map((c) => c.phone));
  let out = text;
  out = scrub(EMAIL, (m) => m.toLowerCase() === own?.email.toLowerCase(), (m) => emails.has(m.toLowerCase()))(out);
  out = scrub(PHONE, (m) => m === own?.phone, (m) => phones.has(m))(out);
  out = scrub(ORDER, (m) => ownOrders.has(m.toUpperCase()), (m) => Boolean(w.order(m)))(out);
  return { text: out, redactions };
}

function allCustomers(session: Session) {
  return session.world.db.prepare("SELECT email, phone FROM customers").all() as Array<{ email: string; phone: string }>;
}
