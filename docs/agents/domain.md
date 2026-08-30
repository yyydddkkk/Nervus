# Domain docs

Nervus is a single-context repository.

## Layout

- `CONTEXT.md` is the canonical domain glossary.
- `docs/adr/` contains accepted architectural decisions.

## Before exploring

Read:

1. `CONTEXT.md`;
2. ADRs under `docs/adr/` relevant to the area being changed.

If either location does not yet exist, proceed silently. Domain documentation is created lazily when terminology or meaningful architectural decisions are resolved.

## Vocabulary

Use the canonical terms defined in `CONTEXT.md` in code, tests, issues, plans and documentation.

Do not replace canonical terms with synonyms listed under `_Avoid_`.

If a required concept is missing, reconsider whether the new terminology is necessary. If it represents a genuine domain distinction, update the glossary through domain modeling.

## Architectural decisions

Before proposing or implementing a change, read relevant ADRs.

If a proposal contradicts an ADR, surface the conflict explicitly rather than silently overriding the existing decision.
