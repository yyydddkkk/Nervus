# Live DeepSeek Reference Coding Host receipt

Date: 2026-08-30

Command:

```sh
pnpm smoke:deepseek:coding
```

Provider configuration used the ignored local `.env`, the OpenAI-compatible Adapter in DeepSeek mode, and `deepseek-v4-flash`. The script recreated two disposable Git fixture repositories under ignored `.nervus/m11-live`, proved their tests failed before execution, ran each task through `runCodingCli --json`, independently reran the tests, inspected the final changed-file set, and scanned Host output plus SessionJournals for the API key.

## Single-file defect repair

- Session: `m11-single-file`
- Terminal status: `completed`
- ToolCalls: 8 (`fs/read`, `fs/write`, and `shell/run`)
- Persisted usage: 10,043 input, 614 output, 10,657 total tokens
- Independent verification: `npm test` passed
- Exact changed files: `src/math.js`
- Tests were not modified

## Scoped multi-file change

- Session: `m11-scoped-multi-file`
- Terminal status: `completed`
- ToolCalls: 13 (`fs/read`, `fs/write`, and `shell/run`)
- Persisted usage: 13,104 input, 1,166 output, 14,270 total tokens
- Independent verification: `npm test` passed
- Exact changed files: `src/farewell.js`, `src/greeting.js`
- `src/AGENTS.md` was read through `fs/read` before the first nested `fs/write`
- Tests were not modified

The generated sanitized machine receipt remains at `.nervus/m11-live/receipt.json` for local inspection. The live harness fails if the API key appears in captured stdout, stderr, Journal events, or the receipt. No API key or raw provider response is committed.
