# DeepSeek Tool-Use evidence

Validation date: 2026-08-30.

This is a sanitized receipt from the opt-in M7 live acceptance host. It contains no API key, raw HTTP headers, or model reasoning text.

## Configuration

- Endpoint: `https://api.deepseek.com`
- Model: `deepseek-v4-flash`
- Protocol: OpenAI-compatible Chat Completions SSE
- Compatibility: `system` instructions, thinking enabled, `reasoning_content` replayed
- Workspace: ignored `.nervus/deepseek-workspace`
- Journal: ignored `.nervus/deepseek-sessions`
- Session: `deepseek-tool-1788097108028`

## Task

The Agent was required to:

1. Read `input/project-notes.md`.
2. Run `wc -w input/project-notes.md`.
3. Write a concise Chinese summary to `output/summary.md`.
4. Read the written file back before claiming completion.

## Observed result

- Turn status: `completed`
- Steps: 4
- ModelCalls: 4
- Model attempts: 4
- ToolCalls completed: 4
- Same-Step behavior: initial `fs/read` and `shell/run` executed in one Step
- Durable revision: 37
- Reasoning characters observed: 282
- Streamed answer characters: 896
- Input tokens: 3,940
- Output tokens: 588
- Total tokens: 4,528
- JSONL restart recovery: passed

The generated artifact was non-empty and read back by the Agent:

```text
.nervus/deepseek-workspace/output/summary.md
SHA-256 d25ea5f00e074a4e8995d35fe9e70fb207951404d17698e34790e9fc28695b0e
Size 365 bytes
```

## Credential and persistence checks

- Runtime files scanned: 3
- API key occurrences found: 0
- `.env`: ignored by Git
- `.nervus/deepseek-workspace`: ignored by Git
- `.nervus/deepseek-sessions`: ignored by Git

## Reproduce

Fill the ignored local `.env`, then run:

```sh
pnpm smoke:deepseek:tools
```

The host fails unless the Turn completes, the summary exists and is non-empty, and the reopened Session has the same revision with a completed latest Turn.
