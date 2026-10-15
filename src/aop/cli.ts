// Compile and validate every AOP: `npm run aop:compile`. Exits 1 on any error.
import { AOP_DIR } from "../config.ts";
import { TOOL_NAMES } from "../agent/tools.ts";
import { aopSetHash, loadAops } from "./compiler.ts";

try {
  const aops = loadAops(AOP_DIR, TOOL_NAMES);
  for (const a of aops.values()) {
    console.log(`ok  ${a.id} v${a.version} #${a.hash}  ${a.steps.length} steps, tools: ${a.tools.join(", ")}`);
  }
  console.log(`\nAOP set #${aopSetHash(aops)}`);
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}
