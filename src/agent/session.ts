import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { World } from "../db/world.ts";

export type TraceEvent =
  | { type: "customer_message"; text: string }
  | { type: "agent_message"; text: string }
  | { type: "agent_note"; text: string }
  | { type: "model_call"; model: string; stop_reason: string | null; latency_ms: number; input_tokens: number; output_tokens: number; cache_read: number; cache_write: number }
  | { type: "procedure_loaded"; aop_id: string; version: number }
  | { type: "step"; aop_id: string; step: number; title: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; aop_id: string | null; step: number | null }
  | { type: "tool_result"; id: string; name: string; ok: boolean; output: unknown }
  | { type: "guardrail"; rule: string; decision: "allow" | "block" | "require_approval" | "would_block" | "redact"; tool?: string; detail: string }
  | { type: "handoff"; ticket_id: string; reason: string; summary: string }
  | { type: "approval"; refund_id: string; decision: "approved" | "denied"; by: string }
  | { type: "error"; message: string };

export type TimedEvent = TraceEvent & { t: number; turn: number };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  model_calls: number;
}

export interface Session {
  id: string;
  world: World;
  createdAt: number;
  turn: number;
  status: "active" | "handoff";
  verifiedCustomerId: string | null;
  failedVerifications: number;
  activeAop: string | null;
  currentStep: number | null;
  /** Orders the agent has looked up, and the customer turn it happened in. */
  lookedUp: Map<string, number>;
  /** Auto-issued refund total this session (prevents splitting a big refund into small ones). */
  autoRefunded: number;
  /** Everything the customer typed, used to decide what identifiers the reply may repeat. */
  customerText: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  trace: TimedEvent[];
  usage: Usage;
}

export function newSession(id?: string): Session {
  return {
    // Unguessable: conversation ids are the only thing gating access to a conversation.
    id: id ?? `conv_${randomUUID()}`,
    world: new World(),
    createdAt: Date.now(),
    turn: 0,
    status: "active",
    verifiedCustomerId: null,
    failedVerifications: 0,
    activeAop: null,
    currentStep: null,
    lookedUp: new Map(),
    autoRefunded: 0,
    customerText: "",
    messages: [],
    trace: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, cost_usd: 0, model_calls: 0 },
  };
}

export function record(session: Session, event: TraceEvent): TimedEvent {
  const e = { ...event, t: Date.now(), turn: session.turn } as TimedEvent;
  session.trace.push(e);
  return e;
}
