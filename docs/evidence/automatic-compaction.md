# Automatic Compaction acceptance receipt

Date: 2026-08-30

`tests/compaction.test.ts` uses a deliberately small model context window to force prior history out of the ordinary assembly budget. Before the main ModelCall can run, Nervus:

1. reports `needsCompaction` from Context assembly;
2. creates a no-Tool summary request for the largest complete prior-Turn range that fits;
3. records the Compaction ModelCall through the normal start, attempt, and completion facts;
4. atomically appends `history/compacted` with `throughSequence`, summary content, and `modelCallId`;
5. reassembles the main request from `history/summary`, subsequent history, and the current Turn.

The test restarts the Kernel over the same SessionJournal and proves the summary remains active while the original covered messages do not re-enter the model request. A second test makes the summary ModelCall fail and proves that the Turn ends as `failed` with no `history/compacted` fact and no main ModelCall that silently omits history.

Run the receipt with:

```sh
pnpm vitest run tests/compaction.test.ts
```
