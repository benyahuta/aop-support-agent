import type { Session } from "../src/agent/session.ts";
import type { Scenario } from "./scenarios.ts";

export interface TrialResult {
  id: string;
  category: Scenario["category"];
  trial: number;
  pass: boolean;
  checks_pass: boolean;
  judge_pass: boolean;
  checks: Array<{ name: string; pass: boolean; detail?: string }>;
  judge: Array<{ criterion: string; pass: boolean; reasoning: string }>;
  transcript: Array<{ role: "customer" | "agent"; text: string }>;
  turn_latency_ms: number[];
  usage: Session["usage"];
  guardrail_events: Array<{ rule: string; decision: string }>;
  procedures: string[];
  handoff: boolean;
  error?: string;
}

const pct = (xs: boolean[]) => (xs.length ? Math.round((1000 * xs.filter(Boolean).length) / xs.length) / 10 : 0);
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

export function summarize(results: TrialResult[]) {
  const byCat: Record<string, number> = {};
  for (const cat of ["happy_path", "edge_case", "adversarial"]) byCat[cat] = pct(results.filter((r) => r.category === cat).map((r) => r.pass));
  const ids = [...new Set(results.map((r) => r.id))];
  const passAll = ids.map((id) => results.filter((r) => r.id === id).every((r) => r.pass));
  const blocks: Record<string, number> = {};
  for (const r of results) for (const g of r.guardrail_events) blocks[`${g.rule}:${g.decision}`] = (blocks[`${g.rule}:${g.decision}`] ?? 0) + 1;
  const agentCost = results.reduce((s, r) => s + r.usage.cost_usd, 0);
  const latencies = results.flatMap((r) => r.turn_latency_ms);
  const totalIn = results.reduce((s, r) => s + r.usage.input_tokens + r.usage.cache_read + r.usage.cache_write, 0);
  const cacheRead = results.reduce((s, r) => s + r.usage.cache_read, 0);
  return {
    conversations: results.length,
    scenarios: ids.length,
    pass_rate: pct(results.map((r) => r.pass)),
    pass_all_trials: pct(passAll),
    checks_pass_rate: pct(results.map((r) => r.checks_pass)),
    judge_pass_rate: pct(results.map((r) => r.judge_pass)),
    by_category: byCat,
    errors: results.filter((r) => r.error).length,
    handoff_rate: pct(results.map((r) => r.handoff)),
    guardrail_interventions: blocks,
    agent_cost_usd: Math.round(agentCost * 10000) / 10000,
    agent_cost_per_conversation_usd: Math.round((agentCost / Math.max(1, results.length)) * 10000) / 10000,
    cache_hit_rate: totalIn ? Math.round((1000 * cacheRead) / totalIn) / 10 : 0,
    turn_latency_p50_ms: quantile(latencies, 0.5),
    turn_latency_p95_ms: quantile(latencies, 0.95),
  };
}

