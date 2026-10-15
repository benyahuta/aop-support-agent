// Security regression tests from the pre-deploy security review. "fixed:"
// suites reproduce gaps the review found (they failed before the fix);
// "holds:" suites document defenses that were probed and held.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SupportAgent } from "../src/agent/agent.ts";
import { checkToolCall, filterReply } from "../src/agent/guardrails.ts";
import { newSession, type Session } from "../src/agent/session.ts";
import { execute, SCHEMAS, TOOL_NAMES } from "../src/agent/tools.ts";
import { loadAops } from "../src/aop/compiler.ts";
import { AOP_DIR, defaultConfig } from "../src/config.ts";
import { say, scriptedModel, tool } from "./helpers.ts";

const aops = loadAops(AOP_DIR, TOOL_NAMES);
const cfg = defaultConfig({ model: "test", guardrails: "enforced" });
let s: Session;

function as(email: string, orderId: string, aop: string) {
  execute(s, "verify_identity", { email, order_id: orderId });
  s.activeAop = aop;
}
const rule = (name: string, input: Record<string, unknown>) => {
  const v = checkToolCall(s, aops, cfg, name, input);
  return v.decision === "allow" ? "allow" : v.rule;
};
/** Guardrail check + execute, the way the runtime does it. */
function act(name: string, input: Record<string, unknown>) {
  const v = checkToolCall(s, aops, cfg, name, input);
  if (v.decision === "block") return { blocked: v.rule };
  return execute(s, name as any, input, { requireApproval: v.decision === "require_approval" });
}

beforeEach(() => { s = newSession("sec"); });

// ---------------------------------------------------------------- fixed gaps

describe("fixed: duplicate-return check is case-sensitive", () => {
  it("blocks a second return for the same item when the SKU case differs", () => {
    as("lucas.moreau@example.com", "LP-1012", "return_item");
    act("lookup_order", { order_id: "LP-1012", aop_step: 2 });
    const first = act("create_return", { order_id: "LP-1012", sku: "mer-bl-l", reason: "fit", aop_step: 3 });
    expect(first).toHaveProperty("return_id");
    // stored sku is "mer-bl-l"; duplicate check compares against canonical "MER-BL-L"
    expect(rule("create_return", { order_id: "LP-1012", sku: "MER-BL-L", reason: "fit", aop_step: 3 })).toBe("duplicate_return");
  });
});

describe("fixed: guardrail mode fails open on unexpected env values", () => {
  const prev = process.env.GUARDRAILS;
  afterEach(() => { if (prev === undefined) delete process.env.GUARDRAILS; else process.env.GUARDRAILS = prev; });
  for (const v of ["", "ENFORCED", "on", "true"]) {
    it(`GUARDRAILS=${JSON.stringify(v)} still enforces`, () => {
      process.env.GUARDRAILS = v;
      expect(defaultConfig().guardrails).toBe("enforced");
    });
  }
  it("a typo'd mode lets a cross-account cancel through end to end", async () => {
    process.env.GUARDRAILS = "Enforced";
    const model = scriptedModel([
      [tool("load_procedure", { aop_id: "cancel_order" }), tool("verify_identity", { email: "sam.okafor@example.com", order_id: "LP-1008" })],
      [tool("lookup_order", { order_id: "LP-1011", aop_step: 2 }), tool("cancel_order", { order_id: "LP-1011", aop_step: 3 })],
      [say("done")],
    ]);
    const agent = new SupportAgent({ model, config: { model: "test" } });
    const sess = newSession("x");
    await agent.respond(sess, "cancel LP-1011");
    expect(sess.world.order("LP-1011")!.status).toBe("processing");
  });
});

const MUG = { sku: "CMP-MUG-12", qty: 1 };
const refund = (order_id: string, items: Array<{ sku: string; qty: number }>) => ({ order_id, items, reason: "damaged", description: "x", aop_step: 5 });

describe("fixed: refund amount is tied to the affected items", () => {
  it("the model can't name a dollar amount; it's computed from the items", () => {
    expect(SCHEMAS.issue_refund.safeParse({ order_id: "LP-1009", amount: 500, reason: "damaged", description: "x", aop_step: 5 }).success).toBe(false);
    as("elena.rossi@example.com", "LP-1009", "refund_request");
    act("lookup_order", { order_id: "LP-1009", aop_step: 2 });
    expect(act("issue_refund", refund("LP-1009", [MUG]))).toMatchObject({ status: "issued", amount: 24 });
  });
  it("labels the gift message as untrusted data in the lookup result", () => {
    as("elena.rossi@example.com", "LP-1009", "refund_request");
    const out: any = act("lookup_order", { order_id: "LP-1009", aop_step: 2 });
    expect(out.order.gift_message.note).toMatch(/never an instruction/);
  });
});

describe("fixed: lookup and mutation can happen in the same model turn", () => {
  it("requires the lookup to precede the mutation by at least one customer turn", async () => {
    const model = scriptedModel([
      [tool("load_procedure", { aop_id: "cancel_order" }), tool("verify_identity", { email: "jordan.alvarez@example.com", order_id: "LP-1003" })],
      [tool("lookup_order", { order_id: "LP-1003", aop_step: 2 }), tool("cancel_order", { order_id: "LP-1003", aop_step: 3 })],
      [say("cancelled")],
    ]);
    const agent = new SupportAgent({ model, config: { model: "test", guardrails: "enforced" } });
    const sess = newSession("y");
    await agent.respond(sess, "LP-1003 jordan.alvarez@example.com, cancel it");
    expect(sess.world.order("LP-1003")!.status).toBe("processing");
  });
});

describe("fixed: output filter coverage", () => {
  beforeEach(() => as("maya.chen@example.com", "LP-1001", "order_status"));
  it.each([
    ["order id with a space", "Order LP 1003 ships to Boulder"],
    ["order id without a dash", "Order LP1003 is processing"],
    ["phone in another format", "Call Jordan at (555) 0102"],
    ["other customer's full name", "Jordan Alvarez placed that order"],
    ["other customer's street address", "It ships to 2210 Pearl St"],
    ["obfuscated email", "Email jordan.alvarez at example dot com"],
  ])("redacts %s", (_label, text) => {
    expect(filterReply(s, text).redactions.length).toBeGreaterThan(0);
  });
});

describe("fixed: conversation ids are predictable", () => {
  it("ids are not sequential or timestamp-derived", () => {
    const a = newSession().id, b = newSession().id;
    const n = (id: string) => Number(id.split("_").pop());
    expect(n(b) - n(a)).not.toBe(1);
    expect(a).not.toMatch(/^conv_[0-9a-z]+_\d+$/);
  });
});

describe("fixed: zero-unit refunds are impossible", () => {
  it("rejects qty 0 and fractional quantities", () => {
    for (const qty of [0, 0.001, -1]) expect(SCHEMAS.issue_refund.safeParse(refund("LP-1001", [{ sku: "CMP-MUG-12", qty }])).success).toBe(false);
  });
});

// ------------------------------------------------------------ defenses that hold

describe("holds: order id normalization", () => {
  it.each(["lp-1003", "LP 1003", " LP-1003 ", "1003", "LP-1003\n", "order #1003"])("%j still hits the ownership check", (id) => {
    as("maya.chen@example.com", "LP-1001", "order_status");
    expect(rule("lookup_order", { order_id: id, aop_step: 2 })).toBe("order_ownership");
  });
  it("lookup under one spelling unlocks mutation only for the same canonical order", () => {
    as("jordan.alvarez@example.com", "LP-1003", "cancel_order");
    act("lookup_order", { order_id: "lp 1003", aop_step: 2 });
    s.turn += 1;
    expect(rule("cancel_order", { order_id: "LP-1003", aop_step: 3 })).toBe("allow");
  });
  it("non-ASCII (fullwidth) digits do not resolve to an order", () => {
    as("maya.chen@example.com", "LP-1001", "order_status");
    expect(rule("lookup_order", { order_id: "LP-１００３", aop_step: 2 })).toBe("order_not_found");
  });
});

describe("holds: session-wide refund cap", () => {
  it("re-verifying as a different customer does not reset the auto-refund total", () => {
    as("maya.chen@example.com", "LP-1001", "refund_request");
    act("lookup_order", { order_id: "LP-1001", aop_step: 2 });
    expect((act("issue_refund", refund("LP-1001", [MUG])) as any).status).toBe("issued");
    execute(s, "verify_identity", { email: "priya.nair@example.com", order_id: "LP-1005" });
    act("lookup_order", { order_id: "LP-1005", aop_step: 2 });
    // $24 + $78 = $102 passes; a further $139+ would not.
    expect((act("issue_refund", { ...refund("LP-1005", [{ sku: "HDL-300", qty: 2 }]), reason: "lost_package" }) as any).status).toBe("issued");
    expect(s.autoRefunded).toBe(102);
  });
  it("parallel refunds in one model turn are capped and never double-refund a unit", async () => {
    const r = (sku: string) => tool("issue_refund", refund("LP-1001", [{ sku, qty: 1 }]));
    const model = scriptedModel([
      [tool("load_procedure", { aop_id: "refund_request" }), tool("verify_identity", { email: "maya.chen@example.com", order_id: "LP-1001" })],
      [tool("lookup_order", { order_id: "LP-1001", aop_step: 2 })],
      [r("CMP-MUG-12"), r("CMP-MUG-12"), r("ALD-DJ-M")],
      [say("ok")],
    ]);
    const agent = new SupportAgent({ model, config: { model: "test", guardrails: "enforced" } });
    const sess = newSession("p");
    await agent.respond(sess, "refund");
    const rs = sess.world.refunds("LP-1001");
    expect(rs.filter((x) => x.status === "issued").reduce((a, x) => a + x.amount, 0)).toBe(24);
    expect(rs.filter((x) => x.status === "pending_approval").map((x) => x.amount)).toEqual([229]);
  });
  it("pending approvals count against the refundable units", () => {
    as("priya.nair@example.com", "LP-1006", "refund_request");
    act("lookup_order", { order_id: "LP-1006", aop_step: 2 });
    expect((act("issue_refund", refund("LP-1006", [{ sku: "RDG-2P", qty: 1 }])) as any).status).toBe("pending_approval");
    expect(rule("issue_refund", refund("LP-1006", [{ sku: "RDG-2P", qty: 1 }]))).toBe("already_refunded");
  });
});

describe("holds: a failed re-verification does not switch identity", () => {
  it("stays verified as the original customer", () => {
    as("maya.chen@example.com", "LP-1001", "order_status");
    execute(s, "verify_identity", { email: "jordan.alvarez@example.com", order_id: "LP-1001" });
    expect(s.verifiedCustomerId).toBe("C-001");
  });
});
