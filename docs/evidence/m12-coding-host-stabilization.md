# M12 Coding Host stabilization receipt

Date: 2026-08-31.

Command:

```sh
pnpm smoke:deepseek:stabilization
```

The harness recreated six disposable Git tasks for both a diagnostic and final pass. Four controlled fixtures covered scoped instructions, a large localized edit, a cross-file rename, and a durable resume correction. Two full Nervus copies covered a seeded `localToolsPlugin` regression and a deterministic long-history Session whose real DeepSeek follow-up produced one durable Compaction per pass.

Both passes completed 6/6 tasks, 8/8 Turns, all independent verifiers, exact scoped instruction ordering, and zero Model retries or Turn failures. The diagnostic pass recorded 53 Steps, 81 ToolCalls, one recoverable Tool error, one Compaction, and 216,763 total tokens. The final pass recorded 46 Steps, 67 ToolCalls, one recoverable task-internal Tool error, one Compaction, and 157,845 total tokens.

The final pass had zero directory-read errors and no instruction violations. `fs/list` was the only promoted Tool. A repeated directory misuse across M11/M12 justified adding an explicit Coding Skill rule that directories use `fs/list` and regular files use `fs/read`. Content-search and file-mutation Shell uses did not recur across two distinct task categories, so `fs/search`, `fs/patch`, and Git-specific Tools remain deferred.

The sanitized per-task dataset is [m12-stabilization.json](./m12-stabilization.json). Raw SessionJournals and disposable repositories remain under ignored `.nervus/m12-live`. The harness fails on API-key exposure, incomplete Turns, verifier failure, instruction-order failure, directory-read mistakes, or missing Compaction.
