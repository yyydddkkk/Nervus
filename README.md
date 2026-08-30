# Nervus

Nervus is an embeddable TypeScript semantic kernel for building pluggable, model-driven agents on top of Cordis.

The project is currently at its foundation milestone. Its canonical vocabulary lives in [CONTEXT.md](./CONTEXT.md), architectural decisions live in [docs/adr](./docs/adr), and the implementation sequence lives in [docs/IMPLEMENTATION.md](./docs/IMPLEMENTATION.md).

## Development

Requires Node.js 22 or newer and pnpm 11.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```
