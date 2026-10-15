import { describe, expect, it } from "vitest";
import { AopCompileError, compileAop, loadAops } from "../src/aop/compiler.ts";
import { AOP_DIR } from "../src/config.ts";
import { TOOL_NAMES } from "../src/agent/tools.ts";

const KNOWN_AOPS = new Set(["refund_request", "return_item", "order_status"]);
const aop = (frontTools: string, steps: string, extra = "") => `---
id: test_proc
title: Test
version: 1
triggers: testing
tools: [${frontTools}]
---

## Steps
${steps}
${extra}`;

describe("AOP compiler", () => {
  it("compiles every shipped AOP", () => {
    const aops = loadAops(AOP_DIR, TOOL_NAMES);
    expect([...aops.keys()].sort()).toEqual(["cancel_order", "order_status", "refund_request", "return_item", "update_address"]);
    const refund = aops.get("refund_request")!;
    expect(refund.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(refund.steps[4].tools).toContain("issue_refund");
    expect(refund.procedureRefs).toEqual(["return_item"]);
  });

  it("extracts tool references per step and keeps policies", () => {
    const c = compileAop(aop("lookup_order", "1. **Verify.** Call `verify_identity`.\n2. **Look.** Call `lookup_order`.", "## Policies\n- Be nice."), "t.md", TOOL_NAMES, KNOWN_AOPS);
    expect(c.steps[0].tools).toEqual(["verify_identity"]); // global tool allowed without listing
    expect(c.steps[1].tools).toEqual(["lookup_order"]);
    expect(c.policies).toEqual(["Be nice."]);
  });

  it("rejects unknown tools in frontmatter", () => {
    expect(() => compileAop(aop("lookup_order, delete_customer", "1. **A.** x"), "t.md", TOOL_NAMES, KNOWN_AOPS)).toThrow(/unknown tool.*delete_customer/);
  });

  it("rejects a step that uses a tool the procedure does not allow", () => {
    expect(() => compileAop(aop("lookup_order", "1. **Refund.** Call `issue_refund`."), "t.md", TOOL_NAMES, KNOWN_AOPS)).toThrow(/issue_refund.*not in this procedure/);
  });

  it("allows policies to name a disallowed tool as a prohibition", () => {
    expect(() => compileAop(aop("lookup_order", "1. **A.** Call `lookup_order`.", "## Policies\n- Do not call `issue_refund` here."), "t.md", TOOL_NAMES, KNOWN_AOPS)).not.toThrow();
  });

  it("rejects non-sequential steps", () => {
    expect(() => compileAop(aop("lookup_order", "1. **A.** x\n3. **C.** y"), "t.md", TOOL_NAMES, KNOWN_AOPS)).toThrow(/numbered 1..N/);
  });

  it("rejects dangling procedure references", () => {
    expect(() => compileAop(aop("lookup_order", "1. **A.** Switch to `refund_requests`."), "t.md", TOOL_NAMES, KNOWN_AOPS)).toThrow(AopCompileError);
  });

  it("requires frontmatter", () => {
    expect(() => compileAop("## Steps\n1. **A.** x", "t.md", TOOL_NAMES, KNOWN_AOPS)).toThrow(/frontmatter/);
  });

  it("hash changes when the source changes", () => {
    const a = compileAop(aop("lookup_order", "1. **A.** x"), "t.md", TOOL_NAMES, KNOWN_AOPS);
    const b = compileAop(aop("lookup_order", "1. **A.** y"), "t.md", TOOL_NAMES, KNOWN_AOPS);
    expect(a.hash).not.toEqual(b.hash);
  });
});
