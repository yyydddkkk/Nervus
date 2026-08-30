# Nervus

Nervus is an embeddable TypeScript semantic kernel for building pluggable, model-driven agents on top of Cordis.

The project has completed its first end-to-end Model-to-Tool Turn milestone. Its complete design lives in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), canonical vocabulary lives in [CONTEXT.md](./CONTEXT.md), architectural decisions live in [docs/adr](./docs/adr), and the implementation sequence lives in [docs/IMPLEMENTATION.md](./docs/IMPLEMENTATION.md).

## Development

Requires Node.js 22 or newer and pnpm 11.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## OpenAI-compatible smoke test

Nervus includes a raw-fetch streaming Adapter for the Chat Completions protocol documented in the [official OpenAI API reference](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions). It can also target compatible providers through `OPENAI_BASE_URL`.

```sh
cp .env.example .env
# Fill OPENAI_API_KEY and OPENAI_MODEL, then load the environment.
pnpm smoke:openai -- "Say hello from Nervus."
```

This command is opt-in and is not part of the deterministic test suite.
