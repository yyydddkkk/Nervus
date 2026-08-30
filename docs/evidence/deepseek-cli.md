# DeepSeek CLI evidence

Validation date: 2026-08-30.

This sanitized receipt covers the M8 reference CLI running against the official DeepSeek endpoint. It contains no API key, HTTP headers, or raw reasoning text.

## Deterministic behavior

`tests/cli.test.ts` proves through the public `runNervusCli` seam that:

- A one-shot chat creates a JSONL Session.
- A second CLI invocation resumes the same Session.
- `sessions list` discovers the persisted ID.
- `sessions inspect` projects two completed Turns.
- Ctrl-C cancels an active ModelCall without destroying the Session.

## Live run

- Session: `m8-live`
- Model: `deepseek-v4-flash`
- Workspace: ignored `.nervus/deepseek-workspace`
- First successful Turn: `fs/read` + `shell/run` in one Step, 2 ToolCalls, 0 errors
- Resume validation: recalled the prior line count and executed `fs/read` on `output/summary.md`
- Latest Turn: `completed`
- Durable revision: 48
- Turn count: 3
- Completed Turns: 2
- Preserved failed Turn: 1
- Completed ToolCalls: 3
- Input tokens: 3,984
- Output tokens: 646
- Total tokens: 4,630

## Failure-driven compatibility fix

The first resume attempt received a DeepSeek 400 because an assistant history message without ToolCalls was serialized as `tool_calls: []`. The Adapter now omits the field when empty. The failed Turn remains in the SessionJournal, and the following resume succeeded on the same Session.

## Commands

```sh
pnpm nervus:dev -- chat --workspace .nervus/deepseek-workspace --session m8-live --new "..."
pnpm nervus:dev -- sessions resume m8-live --workspace .nervus/deepseek-workspace "..."
pnpm nervus:dev -- sessions list --workspace .nervus/deepseek-workspace
pnpm nervus:dev -- sessions inspect m8-live --workspace .nervus/deepseek-workspace
```
