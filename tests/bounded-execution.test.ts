import type { Plugin } from "cordis";
import { describe, expect, it } from "vitest";

import {
  createKernel,
  type ModelAdapter,
  type ModelRequest,
  type ToolDefinition,
} from "../src/index.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function latestUserText(request: ModelRequest): string {
  const userMessages = request.messages.filter(
    (message) => message.role === "user",
  );
  const latest = userMessages.at(-1);
  if (!latest) throw new Error("missing user message");
  const text = latest.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") throw new Error("missing user text");
  return text.text;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("bounded execution", () => {
  it("persists later Inputs but starts their Turns in FIFO order", async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let modelCallCount = 0;

    const model: ModelAdapter = {
      id: "scripted/fifo",
      async *generate(request) {
        modelCallCount += 1;
        const input = latestUserText(request);
        if (modelCallCount === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        yield { type: "text-delta", delta: `done:${input}` };
        yield { type: "response-completed" };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/fifo",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "fifo-agent",
        model: { adapter: model.id, model: "scripted" },
      });
      const session = await kernel.createSession({
        id: "fifo-session",
        agentId: agent.id,
      });

      const first = session.send({
        content: [{ type: "text", text: "first" }],
      });
      await firstStarted.promise;
      const second = session.send({
        content: [{ type: "text", text: "second" }],
      });

      await waitFor(async () => {
        const events = await session.events();
        return events.filter((event) => event.type === "input/accepted").length === 2;
      });
      expect(await session.snapshot()).toMatchObject({
        pendingInputCount: 1,
        turnCount: 1,
        latestTurn: { status: "active" },
      });

      releaseFirst.resolve();
      await expect(first).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "done:first" }],
      });
      await expect(second).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "done:second" }],
      });
    } finally {
      await kernel.dispose();
    }
  });

  it("cancels the active Turn without destroying its Session", async () => {
    const modelStarted = deferred<void>();
    const model: ModelAdapter = {
      id: "scripted/cancellable",
      async *generate(request, context) {
        const input = latestUserText(request);
        if (input === "cancel me") {
          modelStarted.resolve();
          await new Promise<never>((_resolve, reject) => {
            const rejectWithReason = () => reject(context.signal.reason);
            if (context.signal.aborted) rejectWithReason();
            else {
              context.signal.addEventListener("abort", rejectWithReason, {
                once: true,
              });
            }
          });
        }
        yield { type: "text-delta", delta: `done:${input}` };
        yield { type: "response-completed" };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/cancellable",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "cancellable-agent",
        model: { adapter: model.id, model: "scripted" },
      });
      const session = await kernel.createSession({
        id: "cancellable-session",
        agentId: agent.id,
      });

      const cancelled = session.send({
        content: [{ type: "text", text: "cancel me" }],
      });
      await modelStarted.promise;

      expect(session.cancelActiveTurn("user requested cancellation")).toBe(true);
      await expect(cancelled).resolves.toMatchObject({
        status: "cancelled",
        output: [],
      });
      await expect(
        session.send({ content: [{ type: "text", text: "continue" }] }),
      ).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "done:continue" }],
      });
    } finally {
      await kernel.dispose();
    }
  });

  it("fails a Turn when its ModelCall exceeds the Kernel timeout", async () => {
    const model: ModelAdapter = {
      id: "scripted/model-timeout",
      async *generate(_request, context) {
        await new Promise<never>((_resolve, reject) => {
          const rejectWithReason = () => reject(context.signal.reason);
          if (context.signal.aborted) rejectWithReason();
          else {
            context.signal.addEventListener("abort", rejectWithReason, {
              once: true,
            });
          }
        });
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/model-timeout",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({
      plugins: [plugin],
      timeouts: { modelMs: 10, toolMs: 1_000 },
    });

    try {
      const agent = await kernel.createAgent({
        id: "timeout-agent",
        model: { adapter: model.id, model: "scripted" },
      });
      const session = await kernel.createSession({
        id: "timeout-session",
        agentId: agent.id,
      });

      await expect(
        session.send({ content: [{ type: "text", text: "wait" }] }),
      ).resolves.toMatchObject({ status: "failed", output: [] });
      expect(await session.snapshot()).toMatchObject({
        latestTurn: { status: "failed", output: [] },
      });
    } finally {
      await kernel.dispose();
    }
  });

  it("returns a Tool timeout to the model as an error ToolResult", async () => {
    const model: ModelAdapter = {
      id: "scripted/tool-timeout",
      async *generate(request) {
        const toolResult = request.messages.find(
          (message) => message.role === "tool",
        );
        if (!toolResult || toolResult.role !== "tool") {
          yield {
            type: "tool-call",
            call: {
              id: "slow-call",
              toolId: "test/slow",
              arguments: {},
            },
          };
        } else {
          expect(toolResult.status).toBe("error");
          const text = toolResult.content.find((block) => block.type === "text");
          expect(text).toMatchObject({ type: "text" });
          if (!text || text.type !== "text" || !text.text.includes("timed out")) {
            throw new Error("model did not receive the timeout ToolResult");
          }
          yield { type: "text-delta", delta: "recovered" };
        }
        yield { type: "response-completed" };
      },
    };
    const tool: ToolDefinition = {
      id: "test/slow",
      description: "Wait forever unless cancelled.",
      inputSchema: { type: "object" },
      async execute(_input, context) {
        return new Promise<never>((_resolve, reject) => {
          const rejectWithReason = () => reject(context.signal.reason);
          if (context.signal.aborted) rejectWithReason();
          else {
            context.signal.addEventListener("abort", rejectWithReason, {
              once: true,
            });
          }
        });
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/tool-timeout",
      inject: ["models", "tools"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.tools.register(tool);
      },
    };
    const kernel = await createKernel({
      plugins: [plugin],
      timeouts: { modelMs: 1_000, toolMs: 10 },
    });

    try {
      const agent = await kernel.createAgent({
        id: "tool-timeout-agent",
        model: { adapter: model.id, model: "scripted" },
        tools: [tool.id],
      });
      const session = await kernel.createSession({
        id: "tool-timeout-session",
        agentId: agent.id,
      });

      await expect(
        session.send({ content: [{ type: "text", text: "use slow tool" }] }),
      ).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "recovered" }],
      });
    } finally {
      await kernel.dispose();
    }
  });

  it("bounds active Turns across different Sessions", async () => {
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    let startedCount = 0;
    const model: ModelAdapter = {
      id: "scripted/turn-concurrency",
      async *generate(request) {
        startedCount += 1;
        const input = latestUserText(request);
        if (startedCount === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else {
          secondStarted.resolve();
          await releaseSecond.promise;
        }
        yield { type: "text-delta", delta: `done:${input}` };
        yield { type: "response-completed" };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/turn-concurrency",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({
      plugins: [plugin],
      concurrency: {
        maxActiveTurns: 1,
        maxModelCalls: 4,
        maxToolCalls: 16,
      },
    });

    try {
      const agent = await kernel.createAgent({
        id: "concurrency-agent",
        model: { adapter: model.id, model: "scripted" },
      });
      const firstSession = await kernel.createSession({
        id: "concurrency-session-1",
        agentId: agent.id,
      });
      const secondSession = await kernel.createSession({
        id: "concurrency-session-2",
        agentId: agent.id,
      });

      const first = firstSession.send({
        content: [{ type: "text", text: "first" }],
      });
      await firstStarted.promise;
      const second = secondSession.send({
        content: [{ type: "text", text: "second" }],
      });
      await waitFor(async () => {
        const events = await secondSession.events();
        return events.some((event) => event.type === "input/accepted");
      });
      expect(startedCount).toBe(1);

      releaseFirst.resolve();
      await secondStarted.promise;
      expect(startedCount).toBe(2);
      releaseSecond.resolve();

      await expect(first).resolves.toMatchObject({ status: "completed" });
      await expect(second).resolves.toMatchObject({ status: "completed" });
    } finally {
      await kernel.dispose();
    }
  });

  it("returns invalid Tool arguments without executing the Tool", async () => {
    let toolExecuted = false;
    const model: ModelAdapter = {
      id: "scripted/invalid-tool-arguments",
      async *generate(request) {
        const toolResult = request.messages.find(
          (message) => message.role === "tool",
        );
        if (!toolResult || toolResult.role !== "tool") {
          yield {
            type: "tool-call",
            call: {
              id: "invalid-double",
              toolId: "test/number-only",
              arguments: { value: "not-a-number" },
            },
          };
        } else {
          expect(toolResult.status).toBe("error");
          const text = toolResult.content.find((block) => block.type === "text");
          if (
            !text ||
            text.type !== "text" ||
            !text.text.includes("invalid tool arguments")
          ) {
            throw new Error("model did not receive an argument validation error");
          }
          yield { type: "text-delta", delta: "arguments rejected" };
        }
        yield { type: "response-completed" };
      },
    };
    const tool: ToolDefinition = {
      id: "test/number-only",
      description: "Accept only a numeric value.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
      async execute() {
        toolExecuted = true;
        return { status: "success", content: [] };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/invalid-tool-arguments",
      inject: ["models", "tools"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.tools.register(tool);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "validation-agent",
        model: { adapter: model.id, model: "scripted" },
        tools: [tool.id],
      });
      const session = await kernel.createSession({
        id: "validation-session",
        agentId: agent.id,
      });

      await expect(
        session.send({ content: [{ type: "text", text: "validate" }] }),
      ).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "arguments rejected" }],
      });
      expect(toolExecuted).toBe(false);
    } finally {
      await kernel.dispose();
    }
  });

  it("runs same-Step ToolCalls concurrently and returns every result in call order", async () => {
    const bothStarted = deferred<void>();
    const started = new Set<string>();
    const model: ModelAdapter = {
      id: "scripted/parallel-tools",
      async *generate(request) {
        const results = request.messages.filter(
          (message) => message.role === "tool",
        );
        if (results.length === 0) {
          yield {
            type: "tool-call",
            call: { id: "call-a", toolId: "test/barrier", arguments: { id: "a" } },
          };
          yield {
            type: "tool-call",
            call: { id: "call-b", toolId: "test/barrier", arguments: { id: "b" } },
          };
        } else {
          expect(
            results.map((message) =>
              message.role === "tool"
                ? [message.callId, message.status]
                : undefined,
            ),
          ).toEqual([
            ["call-a", "success"],
            ["call-b", "error"],
          ]);
          yield { type: "text-delta", delta: "collected" };
        }
        yield { type: "response-completed" };
      },
    };
    const tool: ToolDefinition = {
      id: "test/barrier",
      description: "Wait for both calls to start.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      async execute(input) {
        const { id } = input as { id: string };
        started.add(id);
        if (started.size === 2) bothStarted.resolve();
        await bothStarted.promise;
        if (id === "b") throw new Error("b failed");
        return {
          status: "success",
          content: [{ type: "text", text: id }],
        };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/parallel-tools",
      inject: ["models", "tools"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.tools.register(tool);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "parallel-agent",
        model: { adapter: model.id, model: "scripted" },
        tools: [tool.id],
      });
      const session = await kernel.createSession({
        id: "parallel-session",
        agentId: agent.id,
      });

      await expect(
        session.send({ content: [{ type: "text", text: "parallel" }] }),
      ).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "collected" }],
      });
    } finally {
      await kernel.dispose();
    }
  });

  it("exhausts before ToolCalls that exceed a TurnLimit can start", async () => {
    let executions = 0;
    const model: ModelAdapter = {
      id: "scripted/tool-limit",
      async *generate() {
        yield {
          type: "tool-call",
          call: { id: "limit-a", toolId: "test/count", arguments: {} },
        };
        yield {
          type: "tool-call",
          call: { id: "limit-b", toolId: "test/count", arguments: {} },
        };
        yield { type: "response-completed" };
      },
    };
    const tool: ToolDefinition = {
      id: "test/count",
      description: "Count executions.",
      inputSchema: { type: "object" },
      async execute() {
        executions += 1;
        return { status: "success", content: [] };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/tool-limit",
      inject: ["models", "tools"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.tools.register(tool);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "limited-agent",
        model: { adapter: model.id, model: "scripted" },
        tools: [tool.id],
        limits: { maxToolCallsPerStep: 1 },
      });
      const session = await kernel.createSession({
        id: "limited-session",
        agentId: agent.id,
      });

      await expect(
        session.send({ content: [{ type: "text", text: "too many" }] }),
      ).resolves.toMatchObject({ status: "exhausted", output: [] });
      expect(executions).toBe(0);
      expect(
        (await session.events()).some(
          (event) => event.type === "tool/call-started",
        ),
      ).toBe(false);
    } finally {
      await kernel.dispose();
    }
  });
});
