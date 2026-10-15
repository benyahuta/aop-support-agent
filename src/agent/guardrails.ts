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
const CONFIRM_FIRST = new Set(["cancel_order", "update_shipping_address"]);

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
    // Irreversible account changes need the customer to have seen the order and
    // confirmed in a later message, not in the same model turn as the lookup.
    if (CONFIRM_FIRST.has(name) && session.lookedUp.get(order.id)! >= session.turn) {
      return block("confirm_before_action", `Tell the customer what will change on ${order.id} and get their explicit confirmation before calling ${name}.`);
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
        // The model picks items; the amount is computed from the order. Each
        // unit can be refunded at most once (issued or pending).
        const items = w.items(order.id);
        let amount = 0;
        const wanted = new Map<string, number>();
        for (const l of input.items as Array<{ sku: string; qty: number }>) {
          const item = items.find((i) => i.sku.toUpperCase() === String(l.sku).trim().toUpperCase());
          if (!item) return block("refund_unknown_item", `SKU ${l.sku} is not on order ${order.id}.`);
          wanted.set(item.sku, (wanted.get(item.sku) ?? 0) + l.qty);
          amount += item.unit_price * l.qty;
        }
        if (items.every((i) => w.refundedQty(order.id, i.sku) >= i.qty)) return block("already_refunded", "Every item on this order has already been refunded.");
        for (const [sku, qty] of wanted) {
          const item = items.find((i) => i.sku === sku)!;
          const left = item.qty - w.refundedQty(order.id, sku);
          if (qty > left) return block("refund_exceeds_purchased", `Only ${left} of ${item.name} can still be refunded (ordered ${item.qty}).`);
        }
        amount = round(amount);
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

// --- output filter ------------------------------------------------------------

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /\(?\b\d{3}\)?[\s.-]?\d{4}\b/g;
const ORDER = /\bLP[\s-]?\d{3,}\b/gi;

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const digits = (x: string) => x.replace(/\D/g, "");

/**
 * Redact identifiers in the reply that belong to someone other than the
 * verified customer and that the customer didn't type themselves: emails (and
 * their local part), phone numbers in any format, order ids in any spacing,
 * full names, and street addresses. Catches cross-account leaks even if every
 * upstream check were somehow bypassed.
 */
export function filterReply(session: Session, text: string): { text: string; redactions: string[] } {
  const w = session.world;
  // NFKC folds lookalikes such as fullwidth digits, so "LP-１００３" typed by the customer counts as typed.
  const customerText = session.customerText.normalize("NFKC");
  const typed = customerText.toLowerCase();
  const typedDigits = digits(customerText);
  const me = session.verifiedCustomerId;
  const others = (w.db.prepare("SELECT id, name, email, phone FROM customers").all() as Array<{ id: string; name: string; email: string; phone: string }>).filter((c) => c.id !== me);
  const ownOrders = new Set(me ? w.ordersFor(me).map((o) => o.id) : []);
  const redactions: string[] = [];
  const redact = (m: string) => { redactions.push(m); return "[redacted]"; };

  let out = text;
  out = out.replace(EMAIL, (m) => (others.some((c) => c.email.toLowerCase() === m.toLowerCase()) && !typed.includes(m.toLowerCase()) ? redact(m) : m));
  out = out.replace(PHONE, (m) => (others.some((c) => digits(c.phone) === digits(m)) && !typedDigits.includes(digits(m)) ? redact(m) : m));
  out = out.replace(ORDER, (m) => {
    const id = `LP-${digits(m)}`;
    return w.order(id) && !ownOrders.has(id) && !typedDigits.includes(digits(m)) ? redact(m) : m;
  });
  for (const c of others) {
    const streets = w.ordersFor(c.id).map((o) => o.shipping_address.split(",")[0]);
    for (const needle of [c.name, c.email.split("@")[0], ...streets]) {
      if (typed.includes(needle.toLowerCase())) continue;
      out = out.replace(new RegExp(escapeRe(needle), "gi"), redact);
    }
  }
  return { text: out, redactions };
}
