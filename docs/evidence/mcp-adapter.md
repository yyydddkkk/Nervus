# MCP Adapter acceptance receipt

Date: 2026-08-30

The deterministic acceptance test uses the official MCP TypeScript SDK v2 on both sides of an in-memory transport. The test server exposes one Tool, one Resource, and one Prompt; Nervus discovers them at Plugin mount and maps them to:

- `mcp/demo/tool/echo`
- `mcp/demo/resource/about`
- `mcp/demo/prompt/greet`

A Scripted Model invokes all three in one Step and observes the ordered results `echo:hi`, `About MCP`, and `Hello Ada` in the following Model request. The Prompt is also visible through the existing available-Skill discovery mechanism.

Run the receipt with:

```sh
pnpm vitest run tests/mcp.test.ts
```

The production entry points are `mcpStdioPlugin`, `mcpHttpPlugin`, and `mcpPlugin` for an application-owned connected Client. Cancellation and progress use the existing Nervus Tool execution context; Client close is tied to Cordis Plugin disposal by default.
