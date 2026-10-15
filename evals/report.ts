import type { TrialResult } from "./summary.ts";

export function renderReport(run: any, results: TrialResult[]): string {
  const s = run.summary;
  const c = run.config;
  const lines = [
    `# Eval report: ${run.label}`,
    "",
    `${run.timestamp} · git ${run.git_sha} · agent \`${c.model}\` (effort ${c.effort}) · guardrails **${c.guardrails}** · prompt ${c.prompt_version} · AOP set #${c.aop_set} · judge \`${c.judge_model}\` · simulator \`${c.sim_model}\``,
    ...(run.note ? ["", `> ${run.note}`] : []),
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Conversations | ${s.conversations} (${s.scenarios} scenarios x ${c.trials} trial${c.trials > 1 ? "s" : ""}) |`,
    `| **Pass rate** (checks + judge) | **${s.pass_rate}%** |`,
    `| Scenarios passing every trial | ${s.pass_all_trials}% |`,
    `| Deterministic checks pass rate | ${s.checks_pass_rate}% |`,
    `| LLM-judge pass rate | ${s.judge_pass_rate}% |`,
    `| Happy path / edge case / adversarial | ${s.by_category.happy_path}% / ${s.by_category.edge_case}% / ${s.by_category.adversarial}% |`,
    `| Handoff rate | ${s.handoff_rate}% |`,
    `| Agent cost per conversation | $${s.agent_cost_per_conversation_usd} |`,
    `| Prompt-cache hit rate (input tokens) | ${s.cache_hit_rate}% |`,
    `| Turn latency p50 / p95 | ${(s.turn_latency_p50_ms / 1000).toFixed(1)}s / ${(s.turn_latency_p95_ms / 1000).toFixed(1)}s |`,
    `| Errors | ${s.errors} |`,
    `| Spend: agent / simulator+judge | $${s.agent_cost_usd} / $${s.eval_overhead_cost_usd} |`,
    "",
    "## Guardrail interventions",
    "",
    Object.keys(s.guardrail_interventions).length
      ? Object.entries(s.guardrail_interventions).sort((a: any, b: any) => b[1] - a[1]).map(([k, v]) => `- \`${k}\`: ${v}`).join("\n")
      : "_none_",
    "",
    "## Results by scenario",
    "",
    "| Scenario | Category | Trials passed | Failures |",
    "|---|---|---|---|",
  ];
  const ids = [...new Set(results.map((r) => r.id))];
  for (const id of ids) {
    const rs = results.filter((r) => r.id === id);
    const fails = rs.flatMap((r) => [
      ...(r.error ? [`error: ${r.error}`] : []),
      ...r.checks.filter((x) => !x.pass).map((x) => `check: ${x.name}${x.detail ? ` (${x.detail})` : ""}`),
      ...r.judge.filter((x) => !x.pass).map((x) => `judge: ${x.criterion.split(":")[0].slice(0, 70)}`),
    ]);
    const uniq = [...new Set(fails)];
    lines.push(`| ${id} | ${rs[0].category} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${uniq.join("<br>").replace(/\|/g, "\\|") || ""} |`);
  }
  lines.push("", "## Failed transcripts", "");
  for (const r of results.filter((x) => !x.pass)) {
    lines.push(`### ${r.id} (trial ${r.trial})`, "");
    for (const j of r.judge.filter((x) => !x.pass)) lines.push(`- **Judge** (${j.criterion.split(":")[0].slice(0, 60)}): ${j.reasoning}`);
    for (const ch of r.checks.filter((x) => !x.pass)) lines.push(`- **Check** ${ch.name}: ${ch.detail ?? "failed"}`);
    lines.push("", "```");
    for (const t of r.transcript) lines.push(`${t.role === "customer" ? "Customer" : "Agent"}: ${t.text}`);
    lines.push("```", "");
  }
  return lines.join("\n");
}
