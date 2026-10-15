// Re-apply a corrected text-only check to a saved run without re-running the
// conversations, and record that it happened.
//   node evals/rescore.ts <label> <scenario-id-prefix>
// Only valid for checks that read replies (not backend state), since saved runs
// keep transcripts but not the database.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.ts";
import { renderReport } from "./report.ts";
import { SCENARIOS } from "./scenarios.ts";
import { summarize } from "./summary.ts";

const [label, prefix] = process.argv.slice(2);
const file = path.join(ROOT, "evals", "results", label, "results.json");
const run = JSON.parse(readFileSync(file, "utf8"));
let changed = 0;
for (const r of run.results) {
  if (!r.id.startsWith(prefix)) continue;
  const scenario = SCENARIOS.find((s) => s.id === r.id)!;
  const replies = r.transcript.filter((t: any) => t.role === "agent").map((t: any) => t.text);
  r.checks = scenario.checks.map((c) => ({ name: c.name, ...c.run({ replies, transcript: r.transcript, session: null as any }) }));
  const before = r.pass;
  r.checks_pass = !r.error && r.checks.every((c: any) => c.pass);
  r.pass = r.checks_pass && r.judge_pass;
  if (before !== r.pass) changed++;
}
const { results, ...meta } = run;
meta.summary = { ...summarize(results), eval_overhead_cost_usd: meta.summary.eval_overhead_cost_usd, wall_clock_s: meta.summary.wall_clock_s };
meta.note = `${meta.note ? meta.note + " " : ""}Rescored ${prefix}* with a corrected text check (${changed} trial(s) changed).`;
writeFileSync(file, JSON.stringify({ ...meta, results }, null, 2));
writeFileSync(path.join(path.dirname(file), "report.md"), renderReport(meta, results));
console.log(meta.note, "pass_rate", meta.summary.pass_rate);
