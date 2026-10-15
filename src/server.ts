import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { decideRefund, SupportAgent } from "./agent/agent.ts";
import { newSession, type Session } from "./agent/session.ts";
import { aopSetHash } from "./aop/compiler.ts";
import { PROMPT_VERSION } from "./agent/prompt.ts";
import { SEED, STORE_CLOCK } from "./db/seed.ts";

const agent = new SupportAgent();
if (process.env.NODE_ENV === "production" && agent.cfg.guardrails !== "enforced") {
  throw new Error("Refusing to start: guardrails must be enforced in production (GUARDRAILS=prompt_only is for evals only).");
}
const sessions = new Map<string, Session>();
const busy = new Set<string>();
const MAX_SESSIONS = 300;
const MAX_MESSAGE_CHARS = 1000;
const MAX_TURNS_PER_CONVERSATION = 25;
const OPS_APPROVAL_ENABLED = process.env.DEMO_OPS_APPROVAL !== "0";

// Cost protection for the public demo (in-memory, per machine; run one machine).
const LIMITS = {
  messagesPerIpHour: Number(process.env.RATE_PER_IP_HOUR ?? 40),
  conversationsPerIpHour: Number(process.env.CONVERSATIONS_PER_IP_HOUR ?? 20),
  requestsPerIpHour: Number(process.env.REQUESTS_PER_IP_HOUR ?? 600),
  messagesPerDay: Number(process.env.RATE_GLOBAL_DAY ?? 600),
  dollarsPerDay: Number(process.env.DAILY_BUDGET_USD ?? 10),
};
const hits = new Map<string, number[]>();
let day = { key: "", messages: 0, dollars: 0 };

function today() {
  const key = new Date().toISOString().slice(0, 10);
  if (key !== day.key) day = { key, messages: 0, dollars: 0 };
  return day;
}

/** Sliding one-hour window per (bucket, ip). Returns true when over the limit. */
function overLimit(bucket: string, ip: string, max: number): boolean {
  const k = `${bucket}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(k) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= max) { hits.set(k, recent); return true; }
  recent.push(now);
  hits.set(k, recent);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.some((t) => now - t < 3_600_000)) hits.delete(k);
}, 600_000).unref();

/** Client IP. Only Fly's proxy header is trusted, and only when running on Fly. */
function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  return (process.env.FLY_APP_NAME && c.req.header("fly-client-ip")) || "local";
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

app.use("*", secureHeaders({
  contentSecurityPolicy: { defaultSrc: ["'self'"], frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'self'"] },
}));
app.get("/healthz", (c) => c.json({ ok: true }));
app.use("/api/*", bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }));
app.use("/api/*", async (c, next) => {
  if (overLimit("req", clientIp(c), LIMITS.requestsPerIpHour)) return c.json({ error: "Too many requests. Please slow down." }, 429);
  await next();
});

app.get("/api/meta", (c) =>
  c.json({
    model: agent.cfg.model,
    effort: agent.cfg.effort,
    guardrails: agent.cfg.guardrails,
    prompt_version: PROMPT_VERSION,
    aop_set: aopSetHash(agent.aops),
    store_clock: STORE_CLOCK,
    ops_approval: OPS_APPROVAL_ENABLED,
    aops: [...agent.aops.values()].map(({ source, ...a }) => a),
    // Fictional demo accounts so visitors can try verified flows.
    demo_accounts: SEED.orders.map((o) => {
      const cust = SEED.customers.find((x) => x.id === o.customer_id)!;
      return { name: cust.name, email: cust.email, order_id: o.id, status: o.status, items: o.items.map((i) => `${i.qty}x ${i.name}`).join(", "), hint: o.hint };
    }),
  }),
);

app.post("/api/conversations", (c) => {
  if (overLimit("conv", clientIp(c), LIMITS.conversationsPerIpHour)) return c.json({ error: "Too many new conversations this hour. Please try again later." }, 429);
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
  const body = (await c.req.json().catch(() => null)) ?? {};
  const text = String(body.text ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!text) return c.json({ error: "Empty message" }, 400);
  if (s.turn >= MAX_TURNS_PER_CONVERSATION) return c.json({ error: "This conversation is at its length limit. Start a new one." }, 429);
  if (busy.has(s.id)) return c.json({ error: "Still working on your last message." }, 409);
  const d = today();
  if (d.messages >= LIMITS.messagesPerDay || d.dollars >= LIMITS.dollarsPerDay) return c.json({ error: "The demo has hit its daily budget. Please try again tomorrow." }, 429);
  if (overLimit("msg", clientIp(c), LIMITS.messagesPerIpHour)) return c.json({ error: "You've sent a lot of messages this hour. Please try again a bit later." }, 429);
  d.messages += 1;
  busy.add(s.id);
  const costBefore = s.usage.cost_usd;
  try {
    const result = await agent.respond(s, text);
    return c.json({ reply: result.reply, ...snapshot(s) });
  } catch (err) {
    console.error("agent error", err instanceof Anthropic.APIError ? `${err.status} ${err.name}` : err);
    const msg = err instanceof Anthropic.RateLimitError ? "We're getting a lot of traffic. Please try again in a minute."
      : err instanceof Anthropic.APIError ? `The model API returned an error (${err.status}). Please try again.`
      : "Something went wrong on our side. Please try again.";
    return c.json({ error: msg }, 502);
  } finally {
    d.dollars += s.usage.cost_usd - costBefore;
    busy.delete(s.id);
  }
});

// Simulated ops: human-in-the-loop decision on a refund that exceeded the
// automatic limit. It only touches this conversation's sandboxed store, and the
// conversation id is an unguessable UUID; a real deployment would put this
// behind staff auth. Disable with DEMO_OPS_APPROVAL=0.
app.post("/api/conversations/:id/refunds/:refundId", async (c) => {
  if (!OPS_APPROVAL_ENABLED) return c.json({ error: "Ops approval is disabled" }, 403);
  const s = getSession(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => null)) ?? {};
  const note = decideRefund(s, c.req.param("refundId"), body.decision === "approve", "ops-demo");
  if (!note) return c.json({ error: "No pending refund with that id" }, 400);
  return c.json({ note, ...snapshot(s) });
});

app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`Larkspur & Pine support agent on http://localhost:${port} (model ${agent.cfg.model}, effort ${agent.cfg.effort}, guardrails ${agent.cfg.guardrails})`);
});
