import { describe, expect, it } from "vitest";

import {
  classifyShellCommand,
  collectCodingMetrics,
} from "../apps/coding-agent/src/metrics.js";
import type { SessionEventEnvelope } from "../src/index.js";

describe("Coding Host stabilization metrics", () => {
  it("classifies Shell purposes without treating verification as discovery friction", () => {
    expect(classifyShellCommand("ls -la && git status")).toEqual([
      "directory-discovery",
      "git-review",
    ]);
    expect(classifyShellCommand("rg 'needle' src && npm test")).toEqual([
      "content-search",
      "verification",
    ]);
    expect(classifyShellCommand("sed -i 's/a/b/' src/a.ts")).toEqual([
      "file-mutation",
    ]);
  });

  it("projects attempts, Tool errors, usage, repeated reads, and directory mistakes", () => {
    const events = [
      event(1, { type: "step/started", turnId: "turn", stepId: "step", index: 1 }),
      event(2, {
        type: "model/attempt-started",
        modelCallId: "model",
        attempt: 1,
      }),
      event(3, {
        type: "model/attempt-failed",
        modelCallId: "model",
        attempt: 1,
        error: "retry",
        retryable: true,
      }),
      event(4, {
        type: "model/call-completed",
        modelCallId: "model",
        content: [],
        toolCalls: [],
        reasoning: "",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      }),
      toolStarted(5, "read-one", "fs/read", { path: "." }),
      event(6, {
        type: "tool/call-completed",
        stepId: "step",
        result: {
          callId: "read-one",
          toolId: "fs/read",
          status: "error",
          content: [{ type: "text", text: "EISDIR: illegal operation on a directory" }],
        },
      }),
      toolStarted(7, "read-two", "fs/read", { path: "src/a.ts" }),
      toolStarted(8, "read-three", "fs/read", { path: "src/a.ts" }),
      toolStarted(9, "shell", "shell/run", { command: "rg todo src && npm test" }),
    ] as const;

    expect(collectCodingMetrics(events)).toMatchObject({
      stepCount: 1,
      toolCallCount: 4,
      toolErrorCount: 1,
      modelAttemptCount: 1,
      modelRetryCount: 1,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      repeatedReads: ["src/a.ts"],
      directoryReadErrorCount: 1,
      shellPurposes: { "content-search": 1, verification: 1 },
    });
  });
});

function toolStarted(
  sequence: number,
  id: string,
  toolId: string,
  args: Readonly<Record<string, unknown>>,
): SessionEventEnvelope {
  return event(sequence, {
    type: "tool/call-started",
    stepId: "step",
    call: { id, toolId, arguments: args },
  });
}

function event(
  sequence: number,
  payload: SessionEventEnvelope["payload"],
): SessionEventEnvelope {
  return {
    schemaVersion: 1,
    id: `event-${sequence}`,
    sessionId: "session",
    sequence,
    timestamp: "2026-08-30T00:00:00.000Z",
    type: payload.type,
    payload,
  };
}
