# Configuration and reference

Reference material that didn't fit in the README: eval flags, server environment variables, deployment, every guardrail rule, what the AOP compiler checks, and the file layout. The essential commands are in the README's "Running it" section.

## Eval runner flags

`npm run eval -- [flags]` (`evals/run.ts`):

| Flag | Default | Meaning |
|---|---|---|
| `--label` | generated from config | Name of the run; results go to `evals/results/<label>/` |
| `--model` | `claude-opus-5-5` | Agent model |
| `--effort` | `low` | Agent effort level |
| `--guardrails` | `enforced` | `enforced` or `prompt_only` |
| `--trials` | `1` | Runs per scenario |
| `--only` | all | Comma-separated scenario id prefixes |
| `--concurrency` | `6` | Conversations in parallel |
| `--aops` | `aops/` | Directory of AOPs to test (for trying a procedure change) |
| `--judge-model` | `claude-sonnet-5-5` | Judge model |
| `--sim-model` | `claude-haiku-5-5` | Customer simulator model |
| `--no-judge` | off | Deterministic checks only |

Examples:

```bash
npm run eval -- --label baseline
npm run eval -- --label prompt-only --guardrails prompt_only
npm run eval -- --label quick --only h01,a0 --trials 3 --no-judge
npm run eval -- --label haiku --model claude-haiku-5-5 --trials 3
```

## Server environment variables

Read by `src/server.ts` and `src/config.ts`. Locally they come from a git-ignored `.env`; on Fly.io, `ANTHROPIC_API_KEY` is a Fly secret and the Docker image sets `NODE_ENV=production`, `PORT=8080`, and `STATE_DIR=/data`.

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Required |
| `AGENT_MODEL` | `claude-opus-5-5` | Agent model |
| `AGENT_EFFORT` | `low` | `low`, `medium`, `high`, `xhigh`, or `max` |
| `GUARDRAILS` | `enforced` | `enforced` or `prompt_only` |
| `RATE_PER_IP_HOUR` | `40` | Messages per IP per hour |
| `RATE_GLOBAL_DAY` | `600` | Messages per day across all visitors |
| `DAILY_BUDGET_USD` | `10` | Daily API spend cap; each turn reserves a worst-case $0.75 before it runs |
| `CONVERSATIONS_PER_IP_HOUR` | `20` | New conversations per IP (IPv6: per /64) per hour |
| `REQUESTS_PER_IP_HOUR` | `600` | All API requests per IP per hour |
| `MAX_IN_FLIGHT` | `4` | Turns processed at once across all visitors |
| `STATE_DIR` | unset (`/data` in Docker) | Where the daily budget is persisted so it survives restarts |
| `DEMO_OPS_APPROVAL` | on | Set to `0` to disable the simulated-ops Approve/Deny endpoint |
| `NODE_ENV` | unset (`production` in Docker) | In `production`, the server refuses to start unless guardrails are enforced |
| `PORT` | `8787` | Listen port (`8080` in the Docker image) |

Fixed limits that are not configurable: 8 KB request bodies, 1,000-character messages, 25 turns per conversation, 300 sessions held in memory, one in-flight message per conversation, 8 model calls per turn, 4,096 output tokens per call, and the $150 per-conversation auto-refund limit.

Other commands:

```bash
npm run typecheck
npm run aop:compile                  # validate every AOP and print the AOP set hash
node evals/rescore.ts baseline a05   # re-apply a corrected text-only check to a saved run
node scripts/screenshot.ts           # regenerate docs/screenshot.png against a running server
```

## Deploying to Fly.io

Config is in `fly.toml`, and the image is built from `Dockerfile`.

```bash
fly apps create larkspur-support-agent
fly volumes create lp_data --size 1 --region iad   # persists the daily budget
grep ANTHROPIC_API_KEY .env | fly secrets import --stage
fly deploy --ha=false                               # one machine: rate limits and budget are per machine
```

## Guardrail rules

Every rule the agent can trip, from `src/agent/guardrails.ts` and `src/agent/agent.ts`. Tool calls that pass record an `allow` event in the trace.

| Rule | Decision | Meaning |
|---|---|---|
| `procedure_scope` | block | Action tool called with no procedure loaded, or not in the loaded procedure's `tools` list. |
| `verification_lockout` | block | Identity verification already failed 3 times; the agent must escalate instead of trying again. |
| `identity_required` | block | Tool touches an order or account but the customer has not been verified. |
| `order_not_found` | block | The order id does not exist. |
| `order_ownership` | block | The order belongs to a different customer than the one verified. |
| `lookup_before_action` | block | A mutating tool (refund, return, cancel, address change) was called before `lookup_order` on that order. |
| `confirm_before_action` | block | Cancel or address change attempted in the same turn as the lookup; the customer has to see the order and confirm in a later message. |
| `cancel_requires_processing` | block | Only orders still in `processing` can be cancelled. |
| `address_requires_processing` | block | Shipping address can only change before the order ships. |
| `return_requires_delivery` | block | Returns can only start after delivery. |
| `return_window` | block | Delivered more than 30 days ago. |
| `return_unknown_item` | block | The SKU is not on that order. |
| `final_sale` | block | Final-sale items cannot be returned for change of mind. |
| `duplicate_return` | block | A return already exists for that item. |
| `lost_package_unconfirmed` | block | A `lost_package` refund was requested but tracking does not show the package as stalled or more than 5 days late. |
| `refund_requires_delivery` | block | Damaged, defective, or wrong-item refunds require a delivered order. |
| `refund_window` | block | Damage claim more than 30 days after delivery; the agent can offer an exception review by a human. |
| `already_refunded` | block | Every unit on the order is already refunded or pending approval. |
| `refund_unknown_item` | block | The SKU is not on that order. |
| `refund_exceeds_purchased` | block | More units requested than remain unrefunded. The agent picks items and quantities; the dollar amount is always computed from the order. |
| `refund_auto_limit` | require_approval | Refunds this conversation would exceed the $150 automatic limit. Counted per conversation, so a large refund can't be split into small ones. The refund is queued as `pending_approval` for a human. |
| `loop_budget` | block | The agent made more than 8 model calls in one turn; the conversation is handed off with reason `agent_error`. |
| `output_pii` | redact | The reply contained another customer's email, phone, order number, name, or street address; it is replaced with `[redacted]`. |

A model refusal isn't a guardrail rule, but it's handled the same way: the conversation is handed to a human with reason `safety_or_legal`.

With `GUARDRAILS=prompt_only`, the checks still run and are logged as `would_block`, but the call goes through. Three data-integrity checks (`order_not_found`, `return_unknown_item`, `refund_unknown_item`) are enforced in both modes because they're backend failures, not policy.

## AOP compiler checks

`src/aop/compiler.ts` refuses to load a procedure that fails any of these, so a bad edit fails at startup and in `npm test`:

- Frontmatter has `id`, `title`, `version`, `triggers`, and `tools`; the id is snake_case; the version is an integer; no two files share an id.
- Every tool in the frontmatter `tools` list exists.
- Every backticked tool a step references is in that procedure's `tools` list, or is always available (`load_procedure`, `search_policy`, `verify_identity`, `escalate_to_human`). Policies may name a disallowed tool, since "do not call `issue_refund`" is a valid rule.
- Steps are numbered 1..N with no gaps.
- A backticked snake_case token that isn't a tool, another procedure, or a known status literal is rejected (this catches typos like `refund_requests`).
- Each compiled AOP gets a short SHA-256 hash of its source, and the set gets a combined hash. Eval runs record both, plus the prompt version and git SHA.

## File layout

```
aops/                    Agent Operating Procedures (markdown)
  _policies.md           Policy knowledge base for search_policy
src/
  server.ts              Hono server: API routes, rate limits, daily budget, sessions, static UI
  net.ts                 IPv6 /64 rate-limit keys
  config.ts              Agent config, model prices, fallback support
  aop/compiler.ts        AOP parser, validator, and content hashing
  aop/cli.ts             npm run aop:compile
  agent/agent.ts         Tool loop, handoffs, human refund approval, step tags
  agent/guardrails.ts    checkToolCall (policy as code) and filterReply (output PII filter)
  agent/tools.ts         Tool definitions, zod schemas, executors
  agent/prompt.ts        System prompt and prompt version
  agent/session.ts       Session state, trace event types, usage
  agent/policy-kb.ts     Loads _policies.md for search_policy
  db/seed.ts             Fictional customers, orders, shipments; fixed store clock
  db/world.ts            Per-conversation in-memory SQLite world
public/                  Customer view and ops view (plain HTML, CSS, JS)
evals/
  scenarios.ts           The 45 scenarios
  checks.ts              Deterministic checks on backend state and trace
  llm.ts                 Customer simulator and LLM judge
  run.ts                 Eval runner
  summary.ts, report.ts  Run summary metrics and markdown report
  rescore.ts             Re-apply corrected text-only checks to a saved run
  compare.ts             Regression comparison between two runs
  results/               Run outputs and history.jsonl
test/                    Vitest unit tests (model calls stubbed), incl. security regressions
scripts/screenshot.ts    Drives a real conversation in Chrome and saves docs/screenshot.png
docs/                    Architecture diagram, screenshots, this file
```

