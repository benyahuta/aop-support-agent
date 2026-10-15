import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "../src/agent/agent.ts";

type Block = { text: string } | { tool: string; input: Record<string, unknown> };

/** A ModelClient that replays scripted assistant turns and records requests. */
/** A turn is a list of blocks, or an Error to throw (simulating an API failure). */
export function scriptedModel(turns: Array<Block[] | Error>): ModelClient & { requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] } {
  let i = 0;
  let id = 0;
  const requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  return {
    requests,
    async create(params) {
      requests.push(structuredClone(params));
      const blocks = turns[i++];
      if (!blocks) throw new Error(`scripted model ran out of turns (call ${i})`);
      if (blocks instanceof Error) throw blocks;
      const content = blocks.map((b) =>
        "text" in b ? { type: "text", text: b.text, citations: null } : { type: "tool_use", id: `tu_${++id}`, name: b.tool, input: b.input },
      );
      const hasTool = blocks.some((b) => "tool" in b);
      return {
        id: `msg_${i}`,
        type: "message",
        role: "assistant",
        model: params.model,
        content,
        stop_reason: hasTool ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as unknown as Anthropic.Beta.BetaMessage;
    },
  };
}

export const tool = (name: string, input: Record<string, unknown>) => ({ tool: name, input });
export const say = (text: string) => ({ text });
