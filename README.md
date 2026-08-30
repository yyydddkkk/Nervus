# Nervus

Nervus is an embeddable TypeScript semantic kernel for building pluggable, model-driven agents on top of Cordis.

The planned M0–M6 kernel is implemented and remains private/experimental while its public interface evolves. Its complete design lives in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), completion evidence lives in [docs/COMPLETION-AUDIT.md](./docs/COMPLETION-AUDIT.md), canonical vocabulary lives in [CONTEXT.md](./CONTEXT.md), architectural decisions live in [docs/adr](./docs/adr), and the implementation sequence lives in [docs/IMPLEMENTATION.md](./docs/IMPLEMENTATION.md).

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
- Scripted and OpenAI-compatible streaming Model Adapters.
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
