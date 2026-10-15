import { readFileSync } from "node:fs";
import path from "node:path";
import { AOP_DIR } from "../config.ts";

/** The policy knowledge base, split into `## Section` chunks for search_policy. */
export const POLICY_KB: Array<{ section: string; text: string }> = readFileSync(path.join(AOP_DIR, "_policies.md"), "utf8")
  .split(/^## /m)
  .slice(1)
  .map((chunk) => {
    const [section, ...rest] = chunk.split("\n");
    return { section: section.trim(), text: rest.join(" ").trim() };
  });
