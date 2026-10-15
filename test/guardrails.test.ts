import { beforeEach, describe, expect, it } from "vitest";
import { loadAops } from "../src/aop/compiler.ts";
import { AOP_DIR, defaultConfig } from "../src/config.ts";
import { checkToolCall, filterReply } from "../src/agent/guardrails.ts";
import { newSession, type Session } from "../src/agent/session.ts";
import { execute, TOOL_NAMES } from "../src/agent/tools.ts";

const aops = loadAops(AOP_DIR, TOOL_NAMES);
const cfg = defaultConfig({ model: "test" });
let s: Session;

function as(customerEmail: string, orderId: string, aop: string) {
  execute(s, "verify_identity", { email: customerEmail, order_id: orderId });
  s.activeAop = aop;
}
const check = (name: string, input: Record<string, unknown>) => checkToolCall(s, aops, cfg, name, input);
const rule = (name: string, input: Record<string, unknown>) => {
  const v = check(name, input);
  return v.decision === "allow" ? "allow" : v.rule;
};

beforeEach(() => { s = newSession("t"); });

describe("procedure scope", () => {
  it("blocks action tools when no procedure is loaded", () => {
    expect(rule("lookup_order", { order_id: "LP-1001" })).toBe("procedure_scope");
  });
  it("blocks tools outside the loaded procedure", () => {
    as("maya.chen@example.com", "LP-1001", "order_status");
    expect(rule("issue_refund", { order_id: "LP-1001", amount: 24, reason: "damaged" })).toBe("procedure_scope");
  });
  it("always allows global tools", () => {
    expect(rule("search_policy", { query: "returns" })).toBe("allow");
    expect(rule("escalate_to_human", { reason: "customer_request" })).toBe("allow");
  });
});

describe("identity and ownership", () => {
  it("requires verification for order lookups", () => {
    s.activeAop = "order_status";
    expect(rule("lookup_order", { order_id: "LP-1002" })).toBe("identity_required");
  });
  it("does not reveal which half of a failed verification was wrong", () => {
    const out = execute(s, "verify_identity", { email: "maya.chen@example.com", order_id: "LP-1003" });
    expect(out.verified).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/jordan|email.*wrong|order.*wrong/i);
  });
  it("blocks access to another customer's order after verifying", () => {
    as("maya.chen@example.com", "LP-1001", "order_status");
    expect(rule("lookup_order", { order_id: "LP-1003" })).toBe("order_ownership");
  });
  it("locks verification after repeated failures", () => {
    for (let i = 0; i < 3; i++) execute(s, "verify_identity", { email: "x@example.com", order_id: "LP-1001" });
    expect(rule("verify_identity", { email: "maya.chen@example.com", order_id: "LP-1001" })).toBe("verification_lockout");
  });
  it("requires a lookup, then confirmation in a later turn, before cancelling", () => {
    as("jordan.alvarez@example.com", "LP-1003", "cancel_order");
    expect(rule("cancel_order", { order_id: "LP-1003" })).toBe("lookup_before_action");
    execute(s, "lookup_order", { order_id: "LP-1003" });
    expect(rule("cancel_order", { order_id: "LP-1003" })).toBe("confirm_before_action");
    s.turn += 1; // customer replied "yes"
    expect(rule("cancel_order", { order_id: "LP-1003" })).toBe("allow");
  });
});

const MUG = { sku: "CMP-MUG-12", qty: 1 };
const JACKET = { sku: "ALD-DJ-M", qty: 1 };
const refund = (order_id: string, items: Array<{ sku: string; qty: number }>, reason = "damaged") => ({ order_id, items, reason, description: "x" });

describe("refund policy", () => {
  beforeEach(() => {
    as("maya.chen@example.com", "LP-1001", "refund_request");
    execute(s, "lookup_order", { order_id: "LP-1001" });
  });
  it("allows a small damaged-item refund and computes the amount from the order", () => {
    expect(rule("issue_refund", refund("LP-1001", [MUG]))).toBe("allow");
    expect(execute(s, "issue_refund", refund("LP-1001", [MUG]))).toMatchObject({ status: "issued", amount: 24 });
  });
  it("routes refunds over the automatic limit to human approval", () => {
    expect(check("issue_refund", refund("LP-1001", [JACKET], "defective"))).toMatchObject({ decision: "require_approval", rule: "refund_auto_limit" });
  });
  it("blocks refunding more units than were bought, or an item not on the order", () => {
    expect(rule("issue_refund", refund("LP-1001", [{ sku: "CMP-MUG-12", qty: 3 }]))).toBe("refund_exceeds_purchased");
    expect(rule("issue_refund", refund("LP-1001", [{ sku: "RDG-2P", qty: 1 }]))).toBe("refund_unknown_item");
  });
  it("never refunds the same unit twice", () => {
    execute(s, "issue_refund", refund("LP-1001", [MUG]));
    expect(rule("issue_refund", refund("LP-1001", [{ sku: "cmp-mug-12", qty: 1 }]))).toBe("refund_exceeds_purchased");
  });
  it("counts the session total so a big refund can't be split", () => {
    execute(s, "issue_refund", refund("LP-1001", [MUG]));
    expect(rule("issue_refund", refund("LP-1001", [JACKET]))).toBe("refund_auto_limit");
  });
  it("blocks damage claims outside the 30-day window", () => {
    s = newSession("t2");
    as("jordan.alvarez@example.com", "LP-1004", "refund_request");
    execute(s, "lookup_order", { order_id: "LP-1004" });
    expect(rule("issue_refund", refund("LP-1004", [{ sku: "MER-BL-L", qty: 1 }], "defective"))).toBe("refund_window");
  });
  it("blocks a second refund on a fully refunded order", () => {
    s = newSession("t3");
    as("theo.brandt@example.com", "LP-1010", "refund_request");
    execute(s, "lookup_order", { order_id: "LP-1010" });
    expect(rule("issue_refund", refund("LP-1010", [MUG]))).toBe("already_refunded");
  });
  it("only allows lost-package refunds when tracking shows it lost", () => {
    expect(rule("issue_refund", refund("LP-1001", [MUG], "lost_package"))).toBe("lost_package_unconfirmed");
    s = newSession("t4");
    as("priya.nair@example.com", "LP-1005", "refund_request");
    execute(s, "lookup_order", { order_id: "LP-1005" });
    expect(rule("issue_refund", refund("LP-1005", [{ sku: "HDL-300", qty: 2 }], "lost_package"))).toBe("allow");
  });
});

describe("order state rules", () => {
  it("can't cancel or re-address a shipped order", () => {
    as("sam.okafor@example.com", "LP-1008", "cancel_order");
    execute(s, "lookup_order", { order_id: "LP-1008" });
    s.turn += 1;
    expect(rule("cancel_order", { order_id: "LP-1008" })).toBe("cancel_requires_processing");
    s.activeAop = "update_address";
    expect(rule("update_shipping_address", { order_id: "LP-1008", new_address: "1 Main St, Seattle, WA 98101" })).toBe("address_requires_processing");
  });
  it("refuses change-of-mind returns on final-sale items", () => {
    as("sam.okafor@example.com", "LP-1007", "return_item");
    execute(s, "lookup_order", { order_id: "LP-1007" });
    expect(rule("create_return", { order_id: "LP-1007", sku: "SS-FLC-S", reason: "changed mind" })).toBe("final_sale");
  });
  it("allows a normal return", () => {
    as("lucas.moreau@example.com", "LP-1012", "return_item");
    execute(s, "lookup_order", { order_id: "LP-1012" });
    expect(rule("create_return", { order_id: "LP-1012", sku: "MER-BL-L", reason: "doesn't fit" })).toBe("allow");
  });
});

describe("output filter", () => {
  it("redacts other customers' identifiers but keeps the verified customer's", () => {
    as("maya.chen@example.com", "LP-1001", "order_status");
    const { text, redactions } = filterReply(s, "Your order LP-1001 is fine. Jordan's email is jordan.alvarez@example.com and order LP-1003.");
    expect(text).toContain("LP-1001");
    expect(text).not.toContain("jordan.alvarez@example.com");
    expect(text).not.toContain("LP-1003");
    expect(redactions).toHaveLength(2);
  });
  it("treats fullwidth digits the customer typed as typed", () => {
    s.customerText = "cancel LP-１００３";
    expect(filterReply(s, "I can't act on LP-1003.").redactions).toHaveLength(0);
  });
  it("does not redact identifiers the customer typed", () => {
    s.customerText = "is LP-1003 mine?";
    expect(filterReply(s, "I can't share details about LP-1003.").redactions).toHaveLength(0);
  });
});
