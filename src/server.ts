import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { decideRefund, SupportAgent } from "./agent/agent.ts";
import { newSession, type Session } from "./agent/session.ts";
import { aopSetHash } from "./aop/compiler.ts";
import { PROMPT_VERSION } from "./agent/prompt.ts";
import { SEED, STORE_CLOCK } from "./db/seed.ts";

const agent = new SupportAgent();
const sessions = new Map<string, Session>();
const MAX_SESSIONS = 300;
const MAX_MESSAGE_CHARS = 1000;
const MAX_TURNS_PER_CONVERSATION = 25;

// Cost protection for the public demo: per-IP hourly cap and a global daily cap.
const PER_IP_PER_HOUR = Number(process.env.RATE_PER_IP_HOUR ?? 40);
const GLOBAL_PER_DAY = Number(process.env.RATE_GLOBAL_DAY ?? 600);
const ipHits = new Map<string, number[]>();
let dayKey = "";
let dayCount = 0;

function rateLimited(ip: string): string | null {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
  if (dayCount >= GLOBAL_PER_DAY) return "The demo has hit its daily message budget. Please try again tomorrow.";
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (hits.length >= PER_IP_PER_HOUR) return "You've sent a lot of messages this hour. Please try again a bit later.";
  hits.push(now);
  ipHits.set(ip, hits);
  dayCount += 1;
  return null;
}

function getSession(id: string): Session | undefined {
  const s = sessions.get(id);
  if (s) { sessions.delete(id); sessions.set(id, s); } // LRU touch
  return s;
}

function snapshot(s: Session) {
  const w = s.world;
  const verified = s.verifiedCustomerId ? w.customer(s.verifiedCustomerId) : null;
  return {
    id: s.id,
    status: s.status,
    verified_customer: verified ? { id: verified.id, name: verified.name } : null,
    active_aop: s.activeAop,
    current_step: s.currentStep,
    usage: s.usage,
    trace: s.trace,
    backend: { refunds: w.refunds(), returns: w.returns(), tickets: w.tickets() },
  };
}

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

app.get("/api/meta", (c) =>
  c.json({
    model: agent.cfg.model,
    effort: agent.cfg.effort,
    guardrails: agent.cfg.guardrails,
    prompt_version: PROMPT_VERSION,
    aop_set: aopSetHash(agent.aops),
    store_clock: STORE_CLOCK,
    aops: [...agent.aops.values()].map(({ source, ...a }) => a),
    // Fictional demo accounts so visitors can try verified flows.
    demo_accounts: SEED.orders.map((o) => {
      const cust = SEED.customers.find((x) => x.id === o.customer_id)!;
      return { name: cust.name, email: cust.email, order_id: o.id, status: o.status, items: o.items.map((i) => `${i.qty}x ${i.name}`).join(", "), hint: o.hint };
    }),
  }),
);

app.post("/api/conversations", (c) => {
  const s = newSession();
  sessions.set(s.id, s);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  return c.json(snapshot(s));
});

app.get("/api/conversations/:id", (c) => {
  const s = getSession(c.req.param("id"));
  return s ? c.json(snapshot(s)) : c.json({ error: "not found" }, 404);
});

app.post("/api/conversations/:id/messages", async (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "Conversation expired. Start a new one." }, 404);
  const body = await c.req.json().catch(() => ({}));
  const text = String(body.text ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!text) return c.json({ error: "Empty message" }, 400);
  if (s.turn >= MAX_TURNS_PER_CONVERSATION) return c.json({ error: "This conversation is at its length limit. Start a new one." }, 429);
  const ip = c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0] ?? "local";
  const limited = rateLimited(ip);
  if (limited) return c.json({ error: limited }, 429);
  try {
    const result = await agent.respond(s, text);
    return c.json({ reply: result.reply, ...snapshot(s) });
  } catch (err) {
    console.error("agent error", err);
    const msg = err instanceof Anthropic.RateLimitError ? "We're getting a lot of traffic. Please try again in a minute."
      : err instanceof Anthropic.APIError ? `The model API returned an error (${err.status}). Please try again.`
      : "Something went wrong on our side. Please try again.";
    return c.json({ error: msg }, 502);
  }
});

// Ops: human-in-the-loop decision on a refund that exceeded the automatic limit.
app.post("/api/conversations/:id/refunds/:refundId", async (c) => {
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const note = decideRefund(s, c.req.param("refundId"), body.decision === "approve", "ops-demo");
  if (!note) return c.json({ error: "No pending refund with that id" }, 400);
  return c.json({ note, ...snapshot(s) });
});

app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`Larkspur & Pine support agent on http://localhost:${port} (model ${agent.cfg.model}, effort ${agent.cfg.effort}, guardrails ${agent.cfg.guardrails})`);
});
