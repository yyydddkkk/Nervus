# M12 evidence-driven Coding Host stabilization

Status: implemented and verified on 2026-08-31.

## Outcome

M12 stabilizes `nervus-code` through repeatable live coding tasks. It measures why the Agent succeeds or fails, implements only evidence-qualified gaps, and preserves before/after receipts. It does not broaden the Kernel or build a speculative Coding Tool suite.

## Existing baseline

The final M11 live runs completed both tasks, but each used four `shell/run` calls for discovery, verification, and Git review. Both used `ls` repeatedly; the scoped task also used `find` for `AGENTS.md` and produced one recoverable `fs/read(".")` directory error. This repeated evidence pre-approves `fs/list` and no other new Tool.

## `fs/list`

M12 adds `fs/list` to the existing root-scoped `localToolsPlugin` before the diagnostic task pass.

- Input selects exactly one relative directory.
- Output is a stable name-sorted array of entries with relative path, name, type, and file size where applicable.
- Entry type distinguishes regular file, directory, symbolic link, and other.
- Listing is non-recursive and does not follow symbolic links.
- Path escape, non-directory input, cancellation, and operation failures use the existing ToolResult error boundary.
- Deterministic tests cover normal listing, ordering, empty directories, symlinks, and root escape.

`fs/search`, `fs/patch`, and Git-specific Tools remain candidates rather than committed scope.

## Live task matrix

The acceptance harness creates disposable Git repositories or worktrees; the Coding Host still edits one explicit workspace in place.

Four controlled realistic fixtures cover:

1. directory discovery and a nested `AGENTS.md` before a scoped edit;
2. a localized defect inside a large file, measuring whole-file rewrite behavior;
3. a cross-file symbol change, measuring content-search behavior;
4. failed verification followed by a durable `resume` correction.

Two disposable Nervus copies cover:

5. diagnosis and repair of a seeded regression in the complete repository;
6. a multi-Turn task that grows history and proves resume plus durable Compaction.

Every task starts from a known failing or unmet condition and has an independent verifier. No acceptance task mutates the primary working tree.

## Evidence and promotion rules

The suite runs in two complete passes:

1. a diagnostic pass after `fs/list` lands;
2. a final acceptance pass after evidence-qualified improvements are processed.

A new Tool, Prompt change, or Kernel capability may advance when the same gap recurs in at least two tasks, or when one task proves a safety, data-loss, or correctness failure. Candidates advance one at a time through a retained failing deterministic test, minimal implementation, affected-task rerun, and before/after metric comparison.

Every formal run records:

- terminal Turn status and independent verification;
- Steps, ToolCalls, Tool errors, Model attempts and retries;
- input, output, and total tokens;
- exact changed files and instruction compliance;
- repeated reads and directory-read mistakes;
- each ShellCall classified as directory discovery, content search, verification, Git review, file mutation, or other.

Verification and Git review are normal Shell uses. Recurring discovery, search, or file-mutation Shell use is evidence for a structured Tool candidate.

## Final acceptance

M12 completes only when the final pass has:

- six completed Turns and six passing independent verifiers;
- exact expected change scope and repository-instruction compliance;
- no directory-read mistakes, Turn failures, unrecovered capability failures, or API-key leakage;
- recorded recoverable provider retries and task-internal diagnostic failures rather than silently excluding them.

Each formal run produces ignored raw Journals and workspaces plus a sanitized machine receipt. Git receives one aggregate JSON dataset and one Markdown conclusion.

## Implementation slices

1. Add `fs/list` with deterministic Tool and Host tests.
2. Build the six-task harness, independent verifiers, metric collector, Shell classifier, and sanitized receipt format.
3. Run the diagnostic pass and evaluate candidates against the promotion rule.
4. Process qualifying candidates one at a time with red-green verification and affected-task reruns.
5. Run the complete final pass, update evidence and the completion audit, then close M12.

## Explicit non-goals

- A complete Coding Tool Pack.
- Automatic worktrees in `nervus-code`.
- General Benchmark or statistical performance claims.
- Capability Library, Profile, or YAML implementation.
- Memory, UI, remote publication, permissions, or sandboxing.
