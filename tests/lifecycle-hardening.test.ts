import type { Plugin } from "cordis";
import { describe, expect, it } from "vitest";

import {
  createKernel,
  type ModelAdapter,
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

describe("lifecycle hardening", () => {
  it("retries classified Model failures and records every attempt", async () => {
    let attempts = 0;
    const model: ModelAdapter = {
      id: "scripted/retry",
      async *generate() {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error(`transient-${attempts}`), {
            retryable: true,
          });
        }
        yield { type: "text-delta", delta: "retried" };
        yield { type: "response-completed" };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/retry",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({
      plugins: [plugin],
      retry: { baseDelayMs: 0, maxDelayMs: 0 },
    });

    try {
      const agent = await kernel.createAgent({
        id: "retry-agent",
        model: { adapter: model.id, model: "scripted" },
        limits: { maxModelAttempts: 3 },
      });
      const session = await kernel.createSession({
        id: "retry-session",
        agentId: agent.id,
      });

      await expect(
        session.send({ content: [{ type: "text", text: "retry" }] }),
      ).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "retried" }],
      });
      const events = await session.events();
      expect(
        events
          .filter((event) => event.type === "model/attempt-started")
          .map((event) =>
            event.payload.type === "model/attempt-started"
              ? event.payload.attempt
              : 0,
          ),
      ).toEqual([1, 2, 3]);
      expect(
        events
          .filter((event) => event.type === "model/attempt-failed")
          .map((event) =>
            event.payload.type === "model/attempt-failed"
              ? [event.payload.attempt, event.payload.retryable]
              : [],
          ),
      ).toEqual([
        [1, true],
        [2, true],
      ]);
    } finally {
      await kernel.dispose();
    }
  });

  it("waits for an active Model lease before disposing its Cordis Plugin", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const model: ModelAdapter = {
      id: "scripted/lease",
      async *generate() {
        started.resolve();
        await release.promise;
        yield { type: "text-delta", delta: "released" };
        yield { type: "response-completed" };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/model-lease",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel();

    try {
      const fiber = await kernel.context.plugin(plugin);
      const agent = await kernel.createAgent({
        id: "lease-agent",
        model: { adapter: model.id, model: "scripted" },
      });
      const session = await kernel.createSession({
        id: "lease-session",
        agentId: agent.id,
      });
      const turn = session.send({
        content: [{ type: "text", text: "hold lease" }],
      });
      await started.promise;

      let disposed = false;
      const disposal = fiber.dispose().then(() => {
        disposed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(disposed).toBe(false);

      release.resolve();
      await expect(turn).resolves.toMatchObject({ status: "completed" });
      await disposal;
      expect(disposed).toBe(true);
    } finally {
      await kernel.dispose();
    }
  });

  it("holds a Tool provider lease for the complete Turn", async () => {
    const toolStarted = deferred<void>();
    const releaseTool = deferred<void>();
    const model: ModelAdapter = {
      id: "scripted/tool-lease",
      async *generate(request) {
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool-call",
            call: { id: "leased-tool-call", toolId: "test/leased-tool", arguments: {} },
          };
        } else {
          yield { type: "text-delta", delta: "tool lease released" };
        }
        yield { type: "response-completed" };
      },
    };
    const tool: ToolDefinition = {
      id: "test/leased-tool",
      description: "Remain registered for the Turn.",
      inputSchema: { type: "object" },
      async execute() {
        toolStarted.resolve();
        await releaseTool.promise;
        return { status: "success", content: [] };
      },
    };
    const modelPlugin: Plugin.Object<void> = {
      name: "test/tool-lease-model",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const toolPlugin: Plugin.Object<void> = {
      name: "test/tool-lease-provider",
      inject: ["tools"],
      apply(ctx) {
        ctx.tools.register(tool);
      },
    };
    const kernel = await createKernel({ plugins: [modelPlugin] });

    try {
      const toolFiber = await kernel.context.plugin(toolPlugin);
      const agent = await kernel.createAgent({
        id: "tool-lease-agent",
        model: { adapter: model.id, model: "scripted" },
        tools: [tool.id],
      });
      const session = await kernel.createSession({
        id: "tool-lease-session",
        agentId: agent.id,
      });
      const turn = session.send({
        content: [{ type: "text", text: "hold tool lease" }],
      });
      await toolStarted.promise;

      let disposed = false;
      const disposal = toolFiber.dispose().then(() => {
        disposed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(disposed).toBe(false);
      releaseTool.resolve();

      await expect(turn).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "tool lease released" }],
      });
      await disposal;
      expect(disposed).toBe(true);
    } finally {
      await kernel.dispose();
    }
  });

  it("holds ContextContributor registrations for the complete Turn", async () => {
    const toolStarted = deferred<void>();
    const releaseTool = deferred<void>();
    const model: ModelAdapter = {
      id: "scripted/context-lease",
      async *generate(request) {
        expect(request.instructions).toContainEqual({
          type: "text",
          text: "leased context",
        });
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool-call",
            call: { id: "context-wait", toolId: "test/context-wait", arguments: {} },
          };
        } else {
          yield { type: "text-delta", delta: "context retained" };
        }
        yield { type: "response-completed" };
      },
    };
    const tool: ToolDefinition = {
      id: "test/context-wait",
      description: "Wait while a Contributor drains.",
      inputSchema: { type: "object" },
      async execute() {
        toolStarted.resolve();
        await releaseTool.promise;
        return { status: "success", content: [] };
      },
    };
    const capabilities: Plugin.Object<void> = {
      name: "test/context-lease-capabilities",
      inject: ["models", "tools"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.tools.register(tool);
      },
    };
    const contributor: Plugin.Object<void> = {
      name: "test/context-lease-provider",
      inject: ["context"],
      apply(ctx) {
        ctx.context.register({
          id: "test/leased-context",
          contribute() {
            return [
              {
                id: "runtime/leased-context",
                source: "test/leased-context",
                layer: "runtime",
                order: 0,
                retention: "required",
                content: {
                  type: "instructions",
                  blocks: [{ type: "text", text: "leased context" }],
                },
              },
            ];
          },
        });
      },
    };
    const kernel = await createKernel({ plugins: [capabilities] });

    try {
      const contributorFiber = await kernel.context.plugin(contributor);
      const agent = await kernel.createAgent({
        id: "context-lease-agent",
        model: { adapter: model.id, model: "scripted" },
        tools: [tool.id],
      });
      const session = await kernel.createSession({
        id: "context-lease-session",
        agentId: agent.id,
      });
      const turn = session.send({
        content: [{ type: "text", text: "hold context" }],
      });
      await toolStarted.promise;

      let disposed = false;
      const disposal = contributorFiber.dispose().then(() => {
        disposed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(disposed).toBe(false);
      releaseTool.resolve();
      await expect(turn).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "context retained" }],
      });
      await disposal;
    } finally {
      await kernel.dispose();
    }
  });

  it("cancels active Turns and preserves queued Inputs during Kernel disposal", async () => {
    const started = deferred<void>();
    const model: ModelAdapter = {
      id: "scripted/kernel-disposal",
      async *generate(_request, context) {
        started.resolve();
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
      name: "test/kernel-disposal",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });
    const agent = await kernel.createAgent({
      id: "disposal-agent",
      model: { adapter: model.id, model: "scripted" },
    });
    const session = await kernel.createSession({
      id: "disposal-session",
      agentId: agent.id,
    });
    const active = session.send({
      content: [{ type: "text", text: "active" }],
    });
    await started.promise;
    const queued = session.send({
      content: [{ type: "text", text: "queued" }],
    });
    void queued.catch(() => undefined);
    await waitFor(async () => {
      const events = await session.events();
      return events.filter((event) => event.type === "input/accepted").length === 2;
    });

    const disposal = kernel.dispose();
    await expect(active).resolves.toMatchObject({ status: "cancelled" });
    await expect(queued).rejects.toMatchObject({ code: "KERNEL_DISPOSING" });
    await disposal;
    expect(kernel.state).toBe("disposed");
    expect(await session.snapshot()).toMatchObject({ pendingInputCount: 1 });
  });

  it("exposes stable KernelError codes at public call interfaces", async () => {
    const kernel = await createKernel();
    try {
      await expect(
        kernel.createAgent({
          id: "invalid-agent",
          model: { adapter: "missing/adapter", model: "missing" },
        }),
      ).rejects.toMatchObject({
        name: "KernelError",
        code: "INVALID_AGENT_SPEC",
      });
    } finally {
      await kernel.dispose();
    }
  });

  it("enforces a Model timeout even when an Adapter ignores AbortSignal", async () => {
    const model: ModelAdapter = {
      id: "scripted/ignores-abort",
      async *generate() {
        await new Promise<never>(() => undefined);
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/ignores-abort",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({
      plugins: [plugin],
      timeouts: { modelMs: 10 },
      retry: { baseDelayMs: 0, maxDelayMs: 0 },
    });

    try {
      const agent = await kernel.createAgent({
        id: "ignores-abort-agent",
        model: { adapter: model.id, model: "scripted" },
        limits: { maxModelAttempts: 1 },
      });
      const session = await kernel.createSession({
        id: "ignores-abort-session",
        agentId: agent.id,
      });
      await expect(
        session.send({ content: [{ type: "text", text: "timeout" }] }),
      ).resolves.toMatchObject({ status: "failed" });
    } finally {
      await kernel.dispose();
    }
  });

  it("uses an updated AgentSpec only for later Turns", async () => {
    const model: ModelAdapter = {
      id: "scripted/agent-update",
      async *generate(request) {
        const instruction = request.instructions.find(
          (block) => block.type === "text",
        );
        yield {
          type: "text-delta",
          delta:
            instruction?.type === "text" ? instruction.text : "no instruction",
        };
        yield { type: "response-completed" };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/agent-update",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "updatable-agent",
        model: { adapter: model.id, model: "scripted" },
        instructions: [{ type: "text", text: "version one" }],
      });
      const session = await kernel.createSession({
        id: "agent-update-session",
        agentId: agent.id,
      });
      await expect(
        session.send({ content: [{ type: "text", text: "first" }] }),
      ).resolves.toMatchObject({
        output: [{ type: "text", text: "version one" }],
      });

      await kernel.updateAgent({
        id: agent.id,
        model: { adapter: model.id, model: "scripted" },
        instructions: [{ type: "text", text: "version two" }],
      });
      await expect(
        session.send({ content: [{ type: "text", text: "second" }] }),
      ).resolves.toMatchObject({
        output: [{ type: "text", text: "version two" }],
      });

      expect(
        (await session.events()).flatMap((event) =>
          event.payload.type === "turn/started"
            ? [event.payload.agent.revision]
            : [],
        ),
      ).toEqual([1, 2]);
    } finally {
      await kernel.dispose();
    }
  });

  it("records a terminal ToolCall fact when its parent Turn is cancelled", async () => {
    const toolStarted = deferred<void>();
    const model: ModelAdapter = {
      id: "scripted/tool-cancellation",
      async *generate() {
        yield {
          type: "tool-call",
          call: {
            id: "cancelled-tool-call",
            toolId: "test/cancellable-tool",
            arguments: {},
          },
        };
        yield { type: "response-completed" };
      },
    };
    const tool: ToolDefinition = {
      id: "test/cancellable-tool",
      description: "Wait until the Turn is cancelled.",
      inputSchema: { type: "object" },
      async execute(_input, context) {
        toolStarted.resolve();
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
      name: "test/tool-cancellation",
      inject: ["models", "tools"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.tools.register(tool);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "tool-cancellation-agent",
        model: { adapter: model.id, model: "scripted" },
        tools: [tool.id],
      });
      const session = await kernel.createSession({
        id: "tool-cancellation-session",
        agentId: agent.id,
      });
      const turn = session.send({
        content: [{ type: "text", text: "cancel tool" }],
      });
      await toolStarted.promise;
      session.cancelActiveTurn("stop the tool");

      await expect(turn).resolves.toMatchObject({ status: "cancelled" });
      expect(
        (await session.events()).filter(
          (event) => event.type === "tool/call-cancelled",
        ),
      ).toMatchObject([
        {
          payload: {
            callId: "cancelled-tool-call",
            reason: "stop the tool",
          },
        },
      ]);
    } finally {
      await kernel.dispose();
    }
  });

  it("broadcasts Tool progress without persisting it as a SessionEvent", async () => {
    const model: ModelAdapter = {
      id: "scripted/tool-progress",
      async *generate(request) {
        const hasResult = request.messages.some(
          (message) => message.role === "tool",
        );
        if (!hasResult) {
          yield {
            type: "tool-call",
            call: { id: "progress-call", toolId: "test/progress", arguments: {} },
          };
        } else {
          yield { type: "text-delta", delta: "progress received" };
        }
        yield { type: "response-completed" };
      },
    };
    const tool: ToolDefinition = {
      id: "test/progress",
      description: "Report progress once.",
      inputSchema: { type: "object" },
      async execute(_input, context) {
        context.reportProgress([{ type: "text", text: "halfway" }]);
        return { status: "success", content: [] };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/tool-progress",
      inject: ["models", "tools"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.tools.register(tool);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });
    const progress: unknown[] = [];
    kernel.context.on("tool/progress", (event) => progress.push(event));

    try {
      const agent = await kernel.createAgent({
        id: "progress-agent",
        model: { adapter: model.id, model: "scripted" },
        tools: [tool.id],
      });
      const session = await kernel.createSession({
        id: "progress-session",
        agentId: agent.id,
      });
      await session.send({ content: [{ type: "text", text: "progress" }] });

      expect(progress).toMatchObject([
        {
          sessionId: "progress-session",
          callId: "progress-call",
          content: [{ type: "text", text: "halfway" }],
        },
      ]);
      expect(
        (await session.events()).some(
          (event) => (event.type as string) === "tool/progress",
        ),
      ).toBe(false);
    } finally {
      await kernel.dispose();
    }
  });

  it("does not start a ModelCall after the Turn attempt limit is exhausted", async () => {
    const model: ModelAdapter = {
      id: "scripted/attempt-limit",
      async *generate() {
        yield {
          type: "tool-call",
          call: { id: "loop-call", toolId: "test/loop", arguments: {} },
        };
        yield { type: "response-completed" };
      },
    };
    const tool: ToolDefinition = {
      id: "test/loop",
      description: "Return immediately.",
      inputSchema: { type: "object" },
      async execute() {
        return { status: "success", content: [] };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/attempt-limit",
      inject: ["models", "tools"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.tools.register(tool);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "attempt-limit-agent",
        model: { adapter: model.id, model: "scripted" },
        tools: [tool.id],
        limits: { maxModelAttempts: 1 },
      });
      const session = await kernel.createSession({
        id: "attempt-limit-session",
        agentId: agent.id,
      });
      await expect(
        session.send({ content: [{ type: "text", text: "loop" }] }),
      ).resolves.toMatchObject({ status: "exhausted" });
      expect(
        (await session.events()).filter(
          (event) => event.type === "model/call-started",
        ),
      ).toHaveLength(1);
    } finally {
      await kernel.dispose();
    }
  });

  it("broadcasts Model deltas while persisting reasoning and usage", async () => {
    const model: ModelAdapter = {
      id: "scripted/model-stream-events",
      async *generate() {
        yield { type: "reasoning-delta", delta: "reason" };
        yield { type: "text-delta", delta: "answer" };
        yield {
          type: "usage",
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
        };
        yield { type: "response-completed" };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/model-stream-events",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });
    const textUpdates: unknown[] = [];
    const reasoningUpdates: unknown[] = [];
    kernel.context.on("model/text-delta", (update) => textUpdates.push(update));
    kernel.context.on("model/reasoning-delta", (update) =>
      reasoningUpdates.push(update),
    );

    try {
      const agent = await kernel.createAgent({
        id: "stream-events-agent",
        model: { adapter: model.id, model: "scripted" },
      });
      const session = await kernel.createSession({
        id: "stream-events-session",
        agentId: agent.id,
      });
      await session.send({ content: [{ type: "text", text: "stream" }] });

      expect(textUpdates).toMatchObject([
        { sessionId: "stream-events-session", delta: "answer" },
      ]);
      expect(reasoningUpdates).toMatchObject([
        { sessionId: "stream-events-session", delta: "reason" },
      ]);
      const completed = (await session.events()).find(
        (event) => event.type === "model/call-completed",
      );
      expect(completed).toMatchObject({
        payload: {
          reasoning: "reason",
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        },
      });
    } finally {
      await kernel.dispose();
    }
  });
});
