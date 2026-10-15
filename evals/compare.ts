// Regression check between two eval runs.
//
//   node evals/compare.ts <baseline-label> <candidate-label>
//
// Prints metric deltas and every scenario whose pass rate moved, and exits 1 if
// any scenario regressed (its pass rate fell by more than one trial's worth), so
// it can gate CI or a prompt/AOP change. Single-trial drops are listed as noise.
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.ts";

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: node evals/compare.ts <baseline-label> <candidate-label>");
  process.exit(2);
}
const load = (label: string) => JSON.parse(readFileSync(path.join(ROOT, "evals", "results", label, "results.json"), "utf8"));
const base = load(a);
const cand = load(b);

const rate = (run: any, id: string) => {
  const rs = run.results.filter((r: any) => r.id === id);
  return rs.length ? rs.filter((r: any) => r.pass).length / rs.length : null;
};

console.log(`baseline  ${a}: ${base.config.model} guardrails=${base.config.guardrails} prompt=${base.config.prompt_version} aops=${base.config.aop_set}`);
console.log(`candidate ${b}: ${cand.config.model} guardrails=${cand.config.guardrails} prompt=${cand.config.prompt_version} aops=${cand.config.aop_set}\n`);

const metrics: Array<[string, (s: any) => number]> = [
  ["pass_rate", (s) => s.pass_rate],
  ["checks_pass_rate", (s) => s.checks_pass_rate],
  ["judge_pass_rate", (s) => s.judge_pass_rate],
  ["happy_path", (s) => s.by_category.happy_path],
  ["edge_case", (s) => s.by_category.edge_case],
  ["adversarial", (s) => s.by_category.adversarial],
  ["cost/conv ($)", (s) => s.agent_cost_per_conversation_usd],
  ["p50 latency (s)", (s) => s.turn_latency_p50_ms / 1000],
];
for (const [name, f] of metrics) {
  const x = f(base.summary), y = f(cand.summary);
  const d = Math.round((y - x) * 1000) / 1000;
  console.log(`${name.padEnd(18)} ${String(x).padStart(8)} -> ${String(y).padEnd(8)} ${d > 0 ? "+" : ""}${d}`);
}

const ids = [...new Set([...base.results, ...cand.results].map((r: any) => r.id))].sort();
const trials = (run: any, id: string) => run.results.filter((r: any) => r.id === id).length;
const regressions: string[] = [];
const fixes: string[] = [];
const flaky: string[] = [];
const other: string[] = [];
for (const id of ids) {
  const x = rate(base, id), y = rate(cand, id);
  if (x === null || y === null || x === y) continue;
  const line = `${id}: ${Math.round(x * 100)}% -> ${Math.round(y * 100)}%`;
  // Losing a single trial is within noise at small trial counts; losing more is a regression.
  const oneTrial = 1 / Math.max(trials(base, id), trials(cand, id)) + 1e-9;
  if (x - y > oneTrial) regressions.push(line);
  else if (y < x) flaky.push(line);
  else if (y === 1) fixes.push(line);
  else other.push(line);
}
console.log(`\nFixed (${fixes.length}):${fixes.map((l) => "\n  + " + l).join("")}`);
console.log(`Regressed, lost more than one trial (${regressions.length}):${regressions.map((l) => "\n  - " + l).join("")}`);
console.log(`Lost one trial, likely noise (${flaky.length}):${flaky.map((l) => "\n  ~ " + l).join("")}`);
console.log(`Improved, not yet clean (${other.length}):${other.map((l) => "\n  ^ " + l).join("")}`);
process.exit(regressions.length ? 1 : 0);
