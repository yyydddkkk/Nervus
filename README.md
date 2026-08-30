# Nervus

Nervus is an embeddable TypeScript semantic kernel for building pluggable, model-driven agents on top of Cordis.

The M0–M10 kernel roadmap is implemented, with concrete Memory plugins intentionally deferred. Nervus remains private/experimental while its public interface evolves. Its complete design lives in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), completion evidence lives in [docs/COMPLETION-AUDIT.md](./docs/COMPLETION-AUDIT.md), canonical vocabulary lives in [CONTEXT.md](./CONTEXT.md), architectural decisions live in [docs/adr](./docs/adr), and the implementation sequence lives in [docs/IMPLEMENTATION.md](./docs/IMPLEMENTATION.md).

## Development

Requires Node.js 22 or newer and pnpm 11.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
```

## Implemented kernel surface

- Cordis-backed Kernel lifecycle with typed Agent/Session facade.
- Versioned AgentSpec snapshots, FIFO Inputs, bounded Turns and parallel Tools.
- Memory and atomic JSONL SessionJournals with replay and interrupted recovery.
- Layered ContextBlocks, model-aware budgets, truncation reports and Skills.
- Automatic durable history Compaction before prior Turns would be discarded.
- Scripted and OpenAI-compatible streaming Model Adapters.
- MCP v2 Adapter for remote Tools, Resources, and Prompts over stdio or Streamable HTTP.
- Root-scoped `fs/read`, `fs/write`, and `shell/run` reference Tools.
- Durable retry/call facts, transient stream/progress events, cancellation and draining leases.

## OpenAI-compatible smoke test

Nervus includes a raw-fetch streaming Adapter for the Chat Completions protocol documented in the [official OpenAI API reference](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions). It can also target compatible providers through `OPENAI_BASE_URL`.

```sh
cp .env.example .env
# Fill OPENAI_API_KEY and OPENAI_MODEL.
pnpm smoke:openai -- "Say hello from Nervus."
```

This command is opt-in and is not part of the deterministic test suite.

### DeepSeek

DeepSeek uses the same Chat Completions shape with a `system` instruction role and streams thinking content through `reasoning_content`. Configure the local ignored `.env` as follows:

```env
OPENAI_API_KEY=your_deepseek_api_key
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-v4-flash
OPENAI_INSTRUCTION_ROLE=system
```

Use `deepseek-v4-flash` for a fast smoke test or change `OPENAI_MODEL` to `deepseek-v4-pro`. The Adapter keeps `developer` as its default for OpenAI and only switches roles when `OPENAI_INSTRUCTION_ROLE=system` is configured.

Run the real Tool-Use acceptance host with:

```sh
pnpm smoke:deepseek:tools
```

It uses an ignored `.nervus/deepseek-workspace`, executes `fs/read`, `shell/run`, `fs/write`, and a read-back verification, writes a JSONL SessionJournal, and checks restart recovery. The sanitized live receipt is recorded in [docs/evidence/deepseek-tool-use.md](./docs/evidence/deepseek-tool-use.md).

## CLI host

Start an interactive DeepSeek Agent in an explicit workspace:

```sh
pnpm nervus:dev -- chat --workspace ./my-project --session my-project
```

Session operations:

```sh
pnpm nervus:dev -- sessions list --workspace ./my-project
pnpm nervus:dev -- sessions inspect my-project --workspace ./my-project
pnpm nervus:dev -- sessions resume my-project --workspace ./my-project
```

The CLI streams model text, reports reasoning and Tool activity, persists JSONL under `<workspace>/.nervus/sessions`, and cancels the active Turn on Ctrl-C. Its live DeepSeek receipt is recorded in [docs/evidence/deepseek-cli.md](./docs/evidence/deepseek-cli.md).

## MCP Adapter

Mount an MCP server as a Cordis Plugin. Remote Tools become Nervus Tools, Resources become read-only Tools, and Prompts become parameterized Tools plus discoverable Skills.

```ts
import { createKernel, mcpStdioPlugin } from "nervus";

const kernel = await createKernel({
  plugins: [
    mcpStdioPlugin({
      id: "workspace",
      command: "node",
      args: ["./mcp-server.js"],
    }),
  ],
});
```

Use `mcpHttpPlugin({ id, url, bearerToken })` for Streamable HTTP, or `mcpPlugin({ id, client })` when the application already owns a connected official MCP Client. Discovery occurs when the Plugin mounts, and the Client is closed when it unmounts unless `closeClient: false` is set.

## Automatic history Compaction

When Context assembly reports that prior history would be dropped, the Agent Loop first asks the Agent's Model to summarize the largest complete range that fits. Nervus atomically records the summary with its covered Session sequence and source ModelCall, then reassembles from that summary plus later events. Original SessionEvents are never deleted.

Compaction calls use the normal timeout, retry, cancellation, concurrency, usage, and model-attempt limits. If no safe source range fits or the Model cannot produce a summary, the Turn fails explicitly instead of continuing with silently missing history.
