import type { ModelUsage, SessionEventEnvelope } from "nervus";

export type ShellPurpose =
  | "directory-discovery"
  | "content-search"
  | "verification"
  | "git-review"
  | "file-mutation"
  | "other";

export interface CodingMetrics {
  readonly stepCount: number;
  readonly toolCallCount: number;
  readonly toolErrorCount: number;
  readonly modelAttemptCount: number;
  readonly modelRetryCount: number;
  readonly usage: ModelUsage;
  readonly repeatedReads: readonly string[];
  readonly directoryReadErrorCount: number;
  readonly shellPurposes: Readonly<Partial<Record<ShellPurpose, number>>>;
}

export function classifyShellCommand(command: string): readonly ShellPurpose[] {
  const purposes: ShellPurpose[] = [];
  if (/(^|[;&|]\s*)(ls|find|tree)(\s|$)/u.test(command)) {
    purposes.push("directory-discovery");
  }
  if (/(^|[;&|]\s*)(rg|grep|ag)(\s|$)/u.test(command)) {
    purposes.push("content-search");
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(test|run\s+test)|\bnode\s+--test|\bvitest\b|\bpytest\b/u.test(command)) {
    purposes.push("verification");
  }
  if (/\bgit\s+(status|diff|show|log)\b/u.test(command)) {
    purposes.push("git-review");
  }
  if (/\bsed\s+-i\b|\bperl\s+-i\b|\bapply_patch\b|(^|\s)(rm|mv|cp)\s|>{1,2}\s*[^&]/u.test(command)) {
    purposes.push("file-mutation");
  }
  return purposes.length > 0 ? purposes : ["other"];
}

export function collectCodingMetrics(
  events: readonly SessionEventEnvelope[],
): CodingMetrics {
  const reads = new Map<string, number>();
  const shellPurposes: Partial<Record<ShellPurpose, number>> = {};
  let stepCount = 0;
  let toolCallCount = 0;
  let toolErrorCount = 0;
  let modelAttemptCount = 0;
  let modelRetryCount = 0;
  let directoryReadErrorCount = 0;
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  for (const envelope of events) {
    const event = envelope.payload;
    if (event.type === "step/started") stepCount += 1;
    if (event.type === "model/attempt-started") modelAttemptCount += 1;
    if (event.type === "model/attempt-failed") modelRetryCount += 1;
    if (event.type === "model/call-completed" && event.usage) {
      usage.inputTokens += event.usage.inputTokens;
      usage.outputTokens += event.usage.outputTokens;
      usage.totalTokens += event.usage.totalTokens;
    }
    if (event.type === "tool/call-started") {
      toolCallCount += 1;
      if (event.call.toolId === "fs/read" && typeof event.call.arguments.path === "string") {
        const path = event.call.arguments.path;
        reads.set(path, (reads.get(path) ?? 0) + 1);
      }
      if (
        event.call.toolId === "shell/run" &&
        typeof event.call.arguments.command === "string"
      ) {
        for (const purpose of classifyShellCommand(event.call.arguments.command)) {
          shellPurposes[purpose] = (shellPurposes[purpose] ?? 0) + 1;
        }
      }
    }
    if (
      event.type === "tool/call-completed" &&
      event.result.status === "error"
    ) {
      toolErrorCount += 1;
      if (
        event.result.toolId === "fs/read" &&
        event.result.content.some(
          (block) => block.type === "text" && block.text.includes("EISDIR"),
        )
      ) {
        directoryReadErrorCount += 1;
      }
    }
    if (event.type === "tool/call-failed") toolErrorCount += 1;
  }

  return {
    stepCount,
    toolCallCount,
    toolErrorCount,
    modelAttemptCount,
    modelRetryCount,
    usage,
    repeatedReads: [...reads]
      .filter(([, count]) => count > 1)
      .map(([path]) => path)
      .sort(),
    directoryReadErrorCount,
    shellPurposes,
  };
}
