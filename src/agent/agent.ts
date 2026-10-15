// The agent runtime: a manual tool-use loop around the Claude Messages API.
//
// A manual loop (rather than the SDK's tool runner) because every tool call has
// to pass through the guardrail layer, be attributed to an AOP step, and be
// written to the trace the ops view renders.
import Anthropic from "@anthropic-ai/sdk";
import { loadAops, renderForAgent, type CompiledAop } from "../aop/compiler.ts";
import { AOP_DIR, costUsd, defaultConfig, supportsDefaultFallback, type AgentConfig } from "../config.ts";
import { checkToolCall, filterReply } from "./guardrails.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { record, type Session, type TimedEvent } from "./session.ts";
import { execute, SCHEMAS, TOOL_DEFS, TOOL_NAMES, type ToolName, type ToolOutput } from "./tools.ts";

type Msg = Anthropic.Beta.BetaMessage;
type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;

/** Seam for tests: anything that can answer a Messages API request. */
export interface ModelClient {
  create(params: Params): Promise<Msg>;
}

export function anthropicClient(client = new Anthropic()): ModelClient {
  return { create: (params) => client.beta.messages.create(params) };
}

export interface TurnResult {
  reply: string;
  events: TimedEvent[];
  status: Session["status"];
}

const HANDOFF_REPLY = "You're connected to our specialist team, and someone will follow up here shortly. Thanks for your patience!";
// Hard failures in the backend (not policy): enforced even when guardrails are off.
const DATA_INTEGRITY_RULES = new Set(["order_not_found", "return_unknown_item"]);

export class SupportAgent {
  readonly cfg: AgentConfig;
  readonly aops: Map<string, CompiledAop>;
  readonly system: string;
  private model: ModelClient;

  constructor(opts: { model?: ModelClient; config?: Partial<AgentConfig>; aops?: Map<string, CompiledAop> } = {}) {
    this.cfg = defaultConfig(opts.config);
    this.aops = opts.aops ?? loadAops(AOP_DIR, TOOL_NAMES);
    this.system = buildSystemPrompt(this.aops);
    this.model = opts.model ?? anthropicClient();
  }

  async respond(session: Session, text: string): Promise<TurnResult> {
    session.turn += 1;
    const start = session.trace.length;
    record(session, { type: "customer_message", text });
    session.customerText += "\n" + text;

    if (session.status === "handoff") {
      record(session, { type: "agent_message", text: HANDOFF_REPLY });
      return { reply: HANDOFF_REPLY, events: session.trace.slice(start), status: session.status };
    }

    session.messages.push({ role: "user", content: text });
    const replyParts: string[] = [];

    for (let i = 0; ; i++) {
      if (i >= this.cfg.maxToolIterations) {
        record(session, { type: "guardrail", rule: "loop_budget", decision: "block", detail: `Exceeded ${this.cfg.maxToolIterations} model calls in one turn; escalating.` });
        this.forceHandoff(session, "agent_error", "Agent exceeded its tool-call budget in one turn.");
        replyParts.push(HANDOFF_REPLY);
        break;
      }

      const msg = await this.callModel(session);
      // Append the full content (including thinking blocks) unchanged: the API
      // requires replayed history to be append-only.
      session.messages.push({ role: "assistant", content: msg.content });

      for (const b of msg.content) if (b.type === "text" && b.text.trim()) replyParts.push(b.text.trim());

      if (msg.stop_reason === "refusal") {
        this.forceHandoff(session, "safety_or_legal", "Model declined to continue this conversation.");
        replyParts.push(HANDOFF_REPLY);
        break;
      }
      const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0 || msg.stop_reason === "max_tokens") break;

      // Run every tool call, then return all results in one user message.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const out = this.runTool(session, tu);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out), ...(out.ok ? {} : { is_error: true }) });
      }
      session.messages.push({ role: "user", content: results });
    }

    let reply = replyParts.join("\n\n") || ((session.status as Session["status"]) === "handoff" ? HANDOFF_REPLY : "Sorry, I didn't catch that. Could you say it another way?");
    const filtered = filterReply(session, reply);
    if (filtered.redactions.length) {
      record(session, { type: "guardrail", rule: "output_pii", decision: "redact", detail: `Redacted ${filtered.redactions.length} identifier(s) belonging to another customer.` });
      reply = filtered.text;
    }
    record(session, { type: "agent_message", text: reply });
    return { reply, events: session.trace.slice(start), status: session.status };
  }

  private async callModel(session: Session): Promise<Msg> {
    const params: Params = {
      model: this.cfg.model,
      max_tokens: 16000,
      system: [{ type: "text", text: this.system }],
      tools: TOOL_DEFS,
      messages: session.messages,
      output_config: { effort: this.cfg.effort },
      // Auto-caching: the breakpoint moves to the end of the history each call,
      // so tools + system + prior turns are read from cache.
      cache_control: { type: "ephemeral" },
      ...(supportsDefaultFallback(this.cfg.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    };
    const t0 = Date.now();
    const msg = await this.model.create(params);
    const u = {
      input_tokens: msg.usage.input_tokens,
      output_tokens: msg.usage.output_tokens,
      cache_read: msg.usage.cache_read_input_tokens ?? 0,
      cache_write: msg.usage.cache_creation_input_tokens ?? 0,
    };
    session.usage.input_tokens += u.input_tokens;
    session.usage.output_tokens += u.output_tokens;
    session.usage.cache_read += u.cache_read;
    session.usage.cache_write += u.cache_write;
    session.usage.cost_usd += costUsd(msg.model ?? this.cfg.model, u);
    session.usage.model_calls += 1;
    record(session, { type: "model_call", model: msg.model, stop_reason: msg.stop_reason, latency_ms: Date.now() - t0, ...u });
    return msg;
  }

  private runTool(session: Session, tu: Anthropic.Beta.BetaToolUseBlock): ToolOutput {
    const step = typeof (tu.input as any)?.aop_step === "number" ? (tu.input as any).aop_step : null;
    record(session, { type: "tool_call", id: tu.id, name: tu.name, input: tu.input, aop_id: session.activeAop, step });
    const done = (out: ToolOutput) => {
      record(session, { type: "tool_result", id: tu.id, name: tu.name, ok: out.ok, output: out });
      return out;
    };

    if (!TOOL_NAMES.has(tu.name)) return done({ ok: false, error: `Unknown tool ${tu.name}` });
    const parsed = SCHEMAS[tu.name as ToolName].safeParse(tu.input);
    if (!parsed.success) return done({ ok: false, error: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
    const input = parsed.data as any;

    if (tu.name === "load_procedure") {
      const aop = this.aops.get(input.aop_id);
      if (!aop) return done({ ok: false, error: `Unknown procedure ${input.aop_id}. Options: ${[...this.aops.keys()].join(", ")}` });
      session.activeAop = aop.id;
      session.currentStep = null;
      record(session, { type: "procedure_loaded", aop_id: aop.id, version: aop.version });
      return done({ ok: true, procedure: renderForAgent(aop) });
    }

    if (step !== null && session.activeAop) {
      const aop = this.aops.get(session.activeAop)!;
      const s = aop.steps.find((x) => x.n === step);
      if (s && step !== session.currentStep) {
        session.currentStep = step;
        record(session, { type: "step", aop_id: aop.id, step, title: s.title });
      }
    }

    const verdict = checkToolCall(session, this.aops, this.cfg, tu.name, input);
    let requireApproval = false;
    if (verdict.decision !== "allow") {
      const enforce = this.cfg.guardrails === "enforced" || DATA_INTEGRITY_RULES.has(verdict.rule);
      if (!enforce) {
        record(session, { type: "guardrail", rule: verdict.rule, decision: "would_block", tool: tu.name, detail: verdict.detail });
      } else if (verdict.decision === "block") {
        record(session, { type: "guardrail", rule: verdict.rule, decision: "block", tool: tu.name, detail: verdict.detail });
        return done({ ok: false, blocked: true, rule: verdict.rule, reason: verdict.detail });
      } else {
        record(session, { type: "guardrail", rule: verdict.rule, decision: "require_approval", tool: tu.name, detail: verdict.detail });
        requireApproval = true;
      }
    } else if (tu.name !== "search_policy" && tu.name !== "verify_identity") {
      record(session, { type: "guardrail", rule: "all_checks", decision: "allow", tool: tu.name, detail: "Passed scope, identity, ownership and policy checks." });
    }

    const out = execute(session, tu.name as ToolName, input, { requireApproval });
    if (tu.name === "escalate_to_human" && out.ok) {
      record(session, { type: "handoff", ticket_id: String(out.ticket_id), reason: input.reason, summary: input.summary });
    }
    return done(out);
  }

  private forceHandoff(session: Session, reason: string, summary: string) {
    if (session.status === "handoff") return;
    const t = session.world.createTicket(session.verifiedCustomerId, reason, summary, "normal");
    session.status = "handoff";
    record(session, { type: "handoff", ticket_id: t.id, reason, summary });
  }
}

/** Human-in-the-loop: a specialist approves or denies a queued refund. */
export function decideRefund(session: Session, refundId: string, approve: boolean, by = "ops"): string | null {
  const r = session.world.decideRefund(refundId, approve, by);
  if (!r) return null;
  record(session, { type: "approval", refund_id: r.id, decision: approve ? "approved" : "denied", by });
  const note = approve
    ? `Update from the Larkspur & Pine team: your refund of $${r.amount.toFixed(2)} for order ${r.order_id} has been approved. It will reach your original payment method in 5-7 business days.`
    : `Update from the Larkspur & Pine team: after review we weren't able to approve the refund for order ${r.order_id}. A specialist will email you with details.`;
  record(session, { type: "agent_message", text: note });
  return note;
}
