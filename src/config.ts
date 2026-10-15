import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AOP_DIR = path.join(ROOT, "aops");

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type GuardrailMode = "enforced" | "prompt_only";

export interface AgentConfig {
  model: string;
  effort: Effort;
  guardrails: GuardrailMode;
  /** Above this, refunds are queued for human approval instead of issued. */
  autoRefundLimit: number;
  maxToolIterations: number;
  maxVerificationAttempts: number;
  /** Wall-clock cap for one customer turn (all model calls together). */
  turnDeadlineMs: number;
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function defaultConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const effort = process.env.AGENT_EFFORT as Effort | undefined;
  return {
    model: process.env.AGENT_MODEL || "claude-opus-5-5",
    effort: effort && EFFORTS.includes(effort) ? effort : "low",
    // Fail closed: anything other than the exact ablation value means enforced.
    guardrails: process.env.GUARDRAILS === "prompt_only" ? "prompt_only" : "enforced",
    autoRefundLimit: 150,
    maxToolIterations: 8,
    maxVerificationAttempts: 3,
    turnDeadlineMs: 150_000,
    ...overrides,
  };
}

// USD per million tokens: [input, output, cache read, cache write (5m)].
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

export function costUsd(model: string, u: { input_tokens: number; output_tokens: number; cache_read: number; cache_write: number }): number {
  // Unknown model (e.g. a server-side fallback): price it at the most expensive known rate.
  const p = PRICES[model] ?? Object.values(PRICES).reduce((a, b) => (b[1] > a[1] ? b : a));
  return (u.input_tokens * p[0] + u.output_tokens * p[1] + u.cache_read * p[2] + u.cache_write * p[3]) / 1e6;
}

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
export function supportsDefaultFallback(model: string): boolean {
  return model === "claude-opus-5-5" || model === "claude-sonnet-5-5";
}
