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
