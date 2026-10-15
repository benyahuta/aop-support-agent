# Configuration

Reference for the eval runner's flags and the server's environment variables. The essential commands are in the README's Setup section.

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
