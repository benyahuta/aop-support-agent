// Eval runner.
//
//   node evals/run.ts --label baseline [--model claude-opus-5-5] [--effort low]
//     [--guardrails enforced|prompt_only] [--trials 2] [--only a01,e0] [--concurrency 6]
//     [--aops path/to/aops] [--judge-model ...] [--sim-model ...]
//
// Writes evals/results/<label>/results.json and report.md, and appends a
// summary line to evals/results/history.jsonl for regression tracking.
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { SupportAgent } from "../src/agent/agent.ts";
import { PROMPT_VERSION } from "../src/agent/prompt.ts";
import { newSession, type Session } from "../src/agent/session.ts";
import { TOOL_NAMES } from "../src/agent/tools.ts";
import { aopSetHash, loadAops } from "../src/aop/compiler.ts";
import { AOP_DIR, ROOT, type Effort, type GuardrailMode } from "../src/config.ts";
import { replyExcludes, type RunArtifacts } from "./checks.ts";

const GLOBAL_CHECKS = { noStepTag: replyExcludes(/<\s*step/i, "leaks an internal <step> tag") };
import { evalSpend, judge, nextCustomerMessage } from "./llm.ts";
import { renderReport } from "./report.ts";
import { summarize, type TrialResult } from "./summary.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";

const { values: args } = parseArgs({
  options: {
    label: { type: "string" },
    model: { type: "string", default: "claude-opus-5-5" },
    effort: { type: "string", default: "low" },
    guardrails: { type: "string", default: "enforced" },
    trials: { type: "string", default: "1" },
    only: { type: "string" },
    concurrency: { type: "string", default: "6" },
    aops: { type: "string", default: AOP_DIR },
    "judge-model": { type: "string", default: "claude-sonnet-5-5" },
    "sim-model": { type: "string", default: "claude-haiku-5-5" },
    "no-judge": { type: "boolean", default: false },
  },
});

const aops = loadAops(path.resolve(args.aops!), TOOL_NAMES);
const config = { model: args.model!, effort: args.effort as Effort, guardrails: args.guardrails as GuardrailMode };
const anthropic = new Anthropic({ maxRetries: 6 });
const agent = new SupportAgent({ config, aops, model: { create: (p) => anthropic.beta.messages.create(p) } });
const trials = Number(args.trials);
const label = args.label ?? `${config.model}-${config.effort}-${config.guardrails}-${Date.now()}`;
const gitSha = (() => { try { return execSync("git rev-parse --short HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "nogit"; } })();
const selected = SCENARIOS.filter((s) => !args.only || args.only.split(",").some((p) => s.id.startsWith(p)));

async function runTrial(s: Scenario, trial: number): Promise<TrialResult> {
  const session = newSession(`${s.id}#${trial}`);
  const transcript: RunArtifacts["transcript"] = [];
  const replies: string[] = [];
  const latencies: number[] = [];
  let error: string | undefined;

  const say = async (text: string) => {
    transcript.push({ role: "customer", text });
    const t0 = Date.now();
    const r = await agent.respond(session, text);
    latencies.push(Date.now() - t0);
    transcript.push({ role: "agent", text: r.reply });
    replies.push(r.reply);
  };

  try {
    await say(s.opening);
    if (s.turns) {
      for (const t of s.turns) {
        if (session.status === "handoff") break;
        await say(t);
      }
    } else if (s.persona) {
      for (let i = 1; i < (s.maxTurns ?? 8) && session.status !== "handoff"; i++) {
        const next = await nextCustomerMessage(args["sim-model"]!, s.persona, transcript);
        if (next.done || !next.message.trim()) break;
        await say(next.message);
      }
    }
  } catch (err) {
    error = err instanceof Anthropic.APIError ? `API ${err.status}: ${err.message}` : String(err);
  }

  const artifacts: RunArtifacts = { session, replies, transcript };
  // Global check on every scenario: internal step tags must never reach the customer.
  const checks = [...s.checks, GLOBAL_CHECKS.noStepTag].map((c) => ({ name: c.name, ...c.run(artifacts) }));
  const judged = error || args["no-judge"] ? [] : await judge(args["judge-model"]!, s.description, s.rubric, session);
  const checksPass = checks.every((c) => c.pass);
  const judgePass = judged.every((j) => j.pass);
  return {
    id: s.id,
    category: s.category,
    trial,
    pass: !error && checksPass && judgePass,
    checks_pass: !error && checksPass,
    judge_pass: !error && judgePass,
    checks,
    judge: judged,
    transcript,
    turn_latency_ms: latencies,
    usage: session.usage,
    guardrail_events: session.trace.filter((e) => e.type === "guardrail" && e.decision !== "allow").map((e: any) => ({ rule: e.rule, decision: e.decision })),
    procedures: session.trace.filter((e) => e.type === "procedure_loaded").map((e: any) => e.aop_id),
    handoff: session.status === "handoff",
    error,
  };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function main() {
  const jobs = selected.flatMap((s) => Array.from({ length: trials }, (_, t) => ({ s, t: t + 1 })));
  console.log(`Running ${selected.length} scenarios x ${trials} trial(s) = ${jobs.length} conversations | ${config.model} effort=${config.effort} guardrails=${config.guardrails} prompt=${PROMPT_VERSION} aops=${aopSetHash(aops)}`);
  const started = Date.now();
  let done = 0;
  const results = await pool(jobs, Number(args.concurrency), async ({ s, t }) => {
    const r = await runTrial(s, t);
    done += 1;
    const failed = [...r.checks.filter((c) => !c.pass).map((c) => c.name), ...r.judge.filter((j) => !j.pass).map((j) => `judge: ${j.criterion.slice(0, 60)}`)];
    console.log(`[${done}/${jobs.length}] ${r.pass ? "PASS" : "FAIL"} ${s.id}#${t}${r.error ? ` ERROR ${r.error}` : ""}${failed.length ? `\n    - ${failed.join("\n    - ")}` : ""}`);
    return r;
  });

  const summary = summarize(results);
  const run = {
    label,
    timestamp: new Date().toISOString(),
    git_sha: gitSha,
    config: { ...config, trials, prompt_version: PROMPT_VERSION, aop_set: aopSetHash(aops), aop_versions: Object.fromEntries([...aops.values()].map((a) => [a.id, `v${a.version}#${a.hash}`])), judge_model: args["judge-model"], sim_model: args["sim-model"] },
    summary: { ...summary, eval_overhead_cost_usd: Math.round(evalSpend.cost_usd * 10000) / 10000, wall_clock_s: Math.round((Date.now() - started) / 1000) },
  };
  const dir = path.join(ROOT, "evals", "results", label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "results.json"), JSON.stringify({ ...run, results }, null, 2));
  writeFileSync(path.join(dir, "report.md"), renderReport(run, results));
  appendFileSync(path.join(ROOT, "evals", "results", "history.jsonl"), JSON.stringify({ ...run, per_scenario: Object.fromEntries([...new Set(results.map((r) => r.id))].map((id) => [id, results.filter((r) => r.id === id).map((r) => r.pass)])) }) + "\n");
  console.log("\n" + JSON.stringify(run.summary, null, 2));
  console.log(`\nWrote ${path.relative(ROOT, dir)}/report.md`);
}

await main();
