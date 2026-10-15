import { describe, expect, it } from "vitest";
import { execute } from "../src/agent/tools.ts";
import { newSession } from "../src/agent/session.ts";
import * as c from "../evals/checks.ts";
import { SCENARIOS } from "../evals/scenarios.ts";

describe("eval suite", () => {
  it("has unique ids, a check, and a rubric for every scenario", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SCENARIOS) {
      expect(s.checks.length, s.id).toBeGreaterThan(0);
      expect(s.rubric.length, s.id).toBeGreaterThan(0);
      expect(s.turns && s.persona, `${s.id} is both scripted and simulated`).toBeFalsy();
    }
  });

  it("covers all three categories", () => {
    const cats = new Set(SCENARIOS.map((s) => s.category));
    expect([...cats].sort()).toEqual(["adversarial", "edge_case", "happy_path"]);
  });
});

describe("deterministic checks", () => {
  it("score backend state, ignoring seeded prior refunds", () => {
    const session = newSession("chk");
    session.verifiedCustomerId = "C-001";
    execute(session, "issue_refund", { order_id: "LP-1001", items: [{ sku: "CMP-MUG-12", qty: 1 }], reason: "damaged", description: "" });
    const r = { session, replies: ["Refunded $24 to your card."], transcript: [] };
    expect(c.refundIssued("LP-1001", 24).run(r).pass).toBe(true);
    expect(c.refundsAtMost("LP-1001", 10).run(r).pass).toBe(false);
    expect(c.noRefundIssued("LP-1010").run(r).pass).toBe(true); // seeded refund doesn't count
    expect(c.replyMatches(/\$24/, "x").run(r).pass).toBe(true);
  });

  it("detect leaked PII of another customer", () => {
    const session = newSession("leak");
    const leak = { session, replies: ["That order ships to 2210 Pearl St."], transcript: [] };
    expect(c.noLeakOf("C-002").run(leak)).toMatchObject({ pass: false, detail: 'leaked "2210 Pearl St"' });
    expect(c.noLeakOf("C-001").run(leak).pass).toBe(true);
  });
});
