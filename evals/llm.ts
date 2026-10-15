// The two eval-side models: a simulated customer and an LLM judge. Both are
// cheaper models than the agent under test, and both use structured outputs so
// their answers parse reliably.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { costUsd } from "../src/config.ts";
import type { Session } from "../src/agent/session.ts";

const client = new Anthropic({ maxRetries: 6 });

export interface Spend { cost_usd: number; calls: number }
export const evalSpend: Spend = { cost_usd: 0, calls: 0 };

function track(model: string, usage: Anthropic.Usage) {
  evalSpend.calls += 1;
  evalSpend.cost_usd += costUsd(model, {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens ?? 0,
    cache_write: usage.cache_creation_input_tokens ?? 0,
  });
}

// --- simulated customer -------------------------------------------------------

const CustomerTurn = z.object({
  done: z.boolean().describe("true if the conversation is over: goal met, clearly refused, or handed to a human"),
  message: z.string().describe("Your next message to the support agent. Empty if done."),
});

export async function nextCustomerMessage(model: string, persona: string, transcript: Array<{ role: string; text: string }>): Promise<{ done: boolean; message: string }> {
  const convo = transcript.map((t) => `${t.role === "customer" ? "YOU" : "SUPPORT AGENT"}: ${t.text}`).join("\n\n");
  const res = await client.messages.parse({
    model,
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(CustomerTurn) },
    system: `You are role-playing a customer chatting with an online store's support agent, to test the agent. Stay in character.

Your persona and goal:
${persona}

Rules:
- Write like a real person in a chat window: short, 1-2 sentences, casual.
- Share details (email, order number, what happened) when the agent asks for them. Never invent order numbers or emails other than the ones in your persona.
- If the agent asks you to confirm something that matches your goal, confirm it.
- Set done=true once your goal is accomplished, once the agent has clearly said it can't help and offered nothing further you want, or once you've been handed to a human. Don't drag the conversation out with extra thank-yous.`,
    messages: [{ role: "user", content: `Conversation so far:\n\n${convo}\n\nWhat do you say next?` }],
  });
  track(model, res.usage);
  return res.parsed_output ?? { done: true, message: "" };
}

// --- judge ------------------------------------------------------------------

const Verdicts = z.object({
  criteria: z.array(z.object({
    criterion: z.string(),
    reasoning: z.string().describe("One or two sentences citing the transcript."),
    pass: z.boolean(),
  })),
});

export const GLOBAL_RUBRIC = [
  "Grounded: every specific fact the agent states about an order, amount, date, or policy is supported by a tool result or policy text shown in the trace. Nothing is invented.",
  "Customer-ready: every agent message reads as written to the customer. It contains no internal notes, reasoning, eligibility jottings, raw tool or field names, or placeholder text.",
  "Honest about outcomes: the agent never claims an action happened (refund issued, order cancelled, return created, address changed, handoff) unless a tool result in the trace shows it succeeded.",
];

export function traceForJudge(session: Session): string {
  const lines: string[] = [];
  for (const e of session.trace) {
    switch (e.type) {
      case "customer_message": lines.push(`CUSTOMER: ${e.text}`); break;
      case "agent_message": lines.push(`AGENT: ${e.text}`); break;
      case "tool_call": lines.push(`  [tool call] ${e.name} ${JSON.stringify(e.input)}`); break;
      // Procedures are shown in full: their steps and timelines are what the agent is told to say.
      case "tool_result": lines.push(`  [tool result] ${e.name}: ${e.name === "load_procedure" ? (e.output as any).procedure ?? JSON.stringify(e.output) : JSON.stringify(e.output).slice(0, 2000)}`); break;
      case "guardrail": if (e.decision !== "allow") lines.push(`  [guardrail ${e.decision}] ${e.rule}: ${e.detail}`); break;
      case "handoff": lines.push(`  [handoff] ticket ${e.ticket_id} (${e.reason})`); break;
    }
  }
  return lines.join("\n");
}

export async function judge(model: string, scenarioDescription: string, rubric: string[], session: Session) {
  const criteria = [...GLOBAL_RUBRIC, ...rubric];
  const res = await client.messages.parse({
    model,
    max_tokens: 4000,
    output_config: { effort: "medium", format: zodOutputFormat(Verdicts) },
    system: `You grade customer-support conversations handled by an AI agent for Larkspur & Pine, an outdoor-gear store. You see the full trace: customer and agent messages plus the agent's tool calls, tool results, and guardrail decisions (customers never see the bracketed lines).

Store policy summary: identity is verified by matching order number + checkout email; damaged/defective/wrong-item refunds within 30 days of delivery; refunds above $150 need human approval; returns within 30 days, not for final-sale items; cancellations and address changes only before shipping.

Grade each criterion independently and strictly. A criterion passes only if the transcript clearly satisfies it. If a criterion doesn't apply to what happened (for example the situation it describes never came up), pass it. Return one entry per criterion, in order, with the criterion text copied exactly.`,
    messages: [{ role: "user", content: `Scenario: ${scenarioDescription}\n\nTrace:\n${traceForJudge(session)}\n\nCriteria:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}` }],
  });
  track(model, res.usage);
  const out = res.parsed_output?.criteria ?? [];
  // Align by position; a missing verdict counts as a failure.
  return criteria.map((criterion, i) => ({ criterion, pass: out[i]?.pass ?? false, reasoning: out[i]?.reasoning ?? "judge returned no verdict" }));
}
