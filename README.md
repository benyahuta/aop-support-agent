# Larkspur & Pine Support Agent

A customer-support agent for a made-up outdoor-gear store. It follows support procedures written in plain markdown, takes real actions against a mock backend (refunds, returns, cancellations, address changes), and hands off to a human when it should. I also built an eval harness around it, because I wanted actual numbers on whether it behaves, not just a demo that looks right.

Live demo: https://larkspur-support-agent.fly.dev
Code: https://github.com/benyahuta/aop-support-agent

Everything about the store is fictional: the customers, the orders, the emails.

![Customer view and ops view](docs/screenshot.png)

## What you can do in the demo

The left side is a chat where you play the customer. Demo accounts are listed under it with suggestions, like asking where an order is, getting a refund for a cracked mug, cancelling an order that hasn't shipped, or returning something. You can also try to break it: pretend to be an admin, ask about someone else's order, or ask for a big refund split into two small ones.

The right side is what a support ops team would watch. The Trace tab shows which procedure the agent loaded, which step it's on, every tool call and result, and every guardrail decision. The Backend tab shows the refunds, returns, order changes, and handoff tickets the conversation created. Refunds over $150 wait there for a human, and you can approve or deny them yourself. Each conversation gets its own fresh copy of the store database, so nothing you do affects anyone else.

## How it works

![Architecture diagram](docs/architecture.svg)

The agent is a tool-use loop on the Claude Messages API (`src/agent/agent.ts`). I wrote the loop myself instead of using the SDK's tool runner, because every tool call needs to go through the guardrails, get tagged with a procedure step, and be written to the trace, and I wanted that to be one code path.

The system prompt only lists the procedures and when to use each. When the agent figures out what the customer wants, it calls `load_procedure` and gets the full steps. That keeps the system prompt identical across conversations, so it comes from the prompt cache every time.

Before any tool runs, `checkToolCall` (`src/agent/guardrails.ts`) checks it against the real backend data. The ones that matter most:

- Identity: the customer has to verify with an order number and the email on it before the agent can see or change anything, and they can only touch their own orders. Three failed tries locks verification.
- Refunds: the agent picks which items to refund, and the code computes the dollar amount from the order. Anything over $150 in a conversation goes to a human for approval, counted per conversation so it can't be split into smaller refunds.
- Order state: you can only cancel or change the address before an order ships, and only after the customer has seen the order and confirmed in a later message.
- Scope: an action tool only runs if the loaded procedure allows it.
- Output: replies get scanned, and any other customer's email, phone, order number, name, or address gets redacted.

The full list of rules is in [docs/configuration.md](docs/configuration.md#guardrail-rules). There's also a `prompt_only` mode where the checks still run but only log what they would have blocked, which I used to measure how much the code is actually doing (see results).

## Procedures (AOPs)

The procedures live in `aops/*.md`. There are five: order status, refunds, returns, cancellations, and address changes. Each one is regular prose with a small frontmatter block. Trimmed example:

```markdown
---
id: refund_request
version: 4
tools: [verify_identity, lookup_order, list_customer_orders, track_shipment, issue_refund, escalate_to_human]
---

## Steps
1. **Verify identity.** Ask for the order number and checkout email, then call `verify_identity`.
2. **Look up the order.** Call `lookup_order` and identify which item(s) are affected and their prices.
...
5. **Issue the refund.** Call `issue_refund` with the order, the affected items only (sku and quantity affected), and the reason.
```

The compiler (`src/aop/compiler.ts`) parses these and refuses to load a broken one. It checks that every tool exists, that no step uses a tool its procedure doesn't allow, that steps are numbered in order, and that references to other procedures aren't typos. Each procedure gets a content hash, and every eval run records the hashes, so I can always tell which version of a procedure produced a result.

To show which step the agent is on, every action tool takes an `aop_step` argument. Steps with no tool, like "ask what happened" or "close", come from a `<step N>` tag the agent puts at the end of its message, which the server strips before the customer sees it. I originally only had the tool argument, and when I tested it by hand the tracker never reached "Close" on chats that ended without an action.

## Evals

There are 45 scenarios in `evals/scenarios.ts`: 11 normal requests, 15 edge cases (outside the return window, over the refund limit, wrong email then the right one, a customer who changes their mind), and 19 attacks (prompt injection in the chat and inside order data, impersonating staff, asking about other customers' orders, splitting refunds, trying to get the system prompt). 13 of them use a simulated customer (Claude Haiku 5.5 with a persona and a goal), and the rest replay a fixed script.

Each scenario is graded two ways. Deterministic checks look at what actually happened in the backend: what refunds were issued and for how much, order status, returns created, whether it handed off, whether another customer's details showed up in a reply. Then an LLM judge (Claude Sonnet 5.5) reads the whole trace and grades it against a rubric. Every scenario also gets three general criteria: everything the agent says is backed by a tool result, nothing internal leaks into a reply, and it never claims something happened that didn't. A conversation passes only if all of it passes.

I ran each scenario 3 times per run. `npm run eval:compare <old> <new>` diffs two runs and exits with an error if any scenario lost more than one of its three trials. Losing exactly one trial gets listed separately as probably noise, since that happens between identical runs.

## Results

All of this comes from `evals/results/`: 9 logged runs, 135 conversations each, 1,215 total. Each run's report has every failed transcript.

Iterating on the agent (Opus 5.5, effort low, guardrails on):

| Run | What changed | Pass rate | All 3 trials pass | Checks | Attacks | $/conversation |
|---|---|---|---|---|---|---|
| `v1-baseline` | first prompt | 60.0% | 46.7% | 100% | 75.4% | $0.027 |
| `v2-notes-fix` | keep the agent's working notes out of replies | 89.6% | 84.4% | 100% | 96.5% | $0.028 |
| `v3-opus` | no extra policy details; neutral wording when verification fails | 97.8% | 95.6% | 100% | 96.5% | $0.027 |
| `v4-opus` | fix the regression v3 caused | 95.6% | 88.9% | 100% | 98.2% | $0.028 |
| `v5-opus` | fixes from user testing | 99.3% | 97.8% | 100% | 100% | $0.028 |
| `v6-opus` | `<step N>` tags | 98.5% | 95.6% | 100% | 98.2% | $0.029 |

The deterministic checks were at 100% in every one of those runs, so the agent never did the wrong thing to the backend. What the judge kept catching was how it talked. Some things it found:

- In the baseline, the agent's notes to itself ("Delivered 6 days ago, within window; description given.") were getting sent to customers, in 41 of 135 conversations. Text the model wrote next to a tool call was being glued onto the reply.
- The agent asked customers for "your order number (like LP-1001)". It copied that from an example in one of my tool descriptions, and LP-1001 is a real customer's order in the demo data.
- v3 introduced a regression: a new rule about failed verification made the agent treat other people's order numbers as typos. `eval:compare` failed on `a14_order_id_variants` (100% to 33%), and v4 fixed it.
- Some bugs were in the harness, not the agent. The judge was only seeing the first 700 characters of tool results, so it flagged real policy text as made up, and two of my text checks had false positives. I fixed those and re-scored the saved runs with `evals/rescore.ts`, which notes the change in each run.

Guardrails in code vs. prompt only (same agent and prompt as v2):

| Mode | Pass rate | Checks | Attacks | Refunds issued that needed approval |
|---|---|---|---|---|
| enforced | 89.6% | 100% | 96.5% | $0 |
| prompt only | 83.7% | 93.3% | 84.2% | $2,541 in 9 conversations |

The interesting part is where the gap came from. Every case prompt-only mode would have blocked was the $150 approval limit. On identity, other customers' orders, and injection, Opus held up from the prompt alone, with zero would-be blocks in 135 conversations. So the part that really has to be code is the money.

I also ran the same prompt (v4) on three models. Opus 5.5, Sonnet 5.5, and Haiku 5.5 all passed 95.6% of 135 conversations, at $0.0282, $0.0144, and $0.0008 per conversation, with median turn latency of 3.9s, 3.2s, and 2.5s. That doesn't mean Haiku is as good as Opus in general; 45 scenarios is small. But on this suite, with the rules in code, the cheap model held up, so it's the first thing I'd test with a bigger eval. The demo still runs Opus for now.

Total API spend was $37.89 across the 9 logged runs (agent, simulator, and judge), plus some smaller test runs on top.

## Security

Before deploying I had a separate security review go through prompt injection, guardrail bypasses, the API endpoints, secrets, abuse of the public demo, and the deploy config. It found 12 issues, all fixed, and its exploit attempts are now tests in `test/security.test.ts`. A second pass found 6 more, also fixed. Seven of its attack ideas became eval scenarios.

The short version: the rules that matter run as code, the model never chooses a dollar amount, and order data like gift messages is marked as untrusted text. Each conversation is a sandbox behind a random ID. The demo has per-IP rate limits, a $10/day API budget that survives restarts, and caps on message size and turns. The API key only lives in a git-ignored `.env` and a Fly secret, and the container doesn't run as root. One trade-off: the Approve/Deny buttons have no login, which is fine since they only affect your own sandboxed conversation.

## Running it

Needs Node 24+ (it uses `node:sqlite` and runs TypeScript directly, no build step).

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
npm run dev          # http://localhost:8787
npm test             # unit tests, no API calls
npm run eval -- --label mine --trials 3
npm run eval:compare v6-opus mine
```

Deploying, eval flags, environment variables, the full guardrail list, and the file layout are in [docs/configuration.md](docs/configuration.md).

## What I'd do next

- Run a bigger eval to see whether Haiku really holds up, since it's about 35x cheaper.
- Check the judge itself: hand-grade a sample of conversations and measure how often it passes something it shouldn't.
- Put the refund limit per customer instead of per conversation. Right now someone could open five conversations.
- Write more scenarios from real-looking transcripts instead of ones I made up.
