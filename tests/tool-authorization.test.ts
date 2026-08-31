import type { Plugin } from "cordis";
import { describe, expect, it } from "vitest";

import {
  createKernel,
  MemorySessionJournal,
  type ModelAdapter,
  type ModelRequest,
  type ToolAuthorizer,
  type ToolDefinition,
  type SessionEvent,
  type SessionEventEnvelope,
  type SessionJournal,
  yoloToolAuthorizer,
} from "../src/index.js";

class RecordingJournal implements SessionJournal {
  readonly journal = new MemorySessionJournal();
  readonly batches: readonly string[][] = [];

  async append(
    sessionId: string,
    expectedRevision: number,
    events: readonly SessionEvent[],
  ): Promise<readonly SessionEventEnvelope[]> {
    (this.batches as string[][]).push(events.map((event) => event.type));
    return this.journal.append(sessionId, expectedRevision, events);
  }

  read(sessionId: string): Promise<readonly SessionEventEnvelope[]> {
    return this.journal.read(sessionId);
  }

  list(): Promise<readonly string[]> {
    return this.journal.list();
  }
}

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

function authorizationError(request: ModelRequest): string | undefined {
  for (const message of request.messages) {
    if (message.role !== "tool") continue;
    for (const block of message.content) {
      if (block.type !== "json") continue;
      const value = block.value;
      if (
        typeof value === "object" &&
        value !== null &&
        "code" in value &&
        typeof value.code === "string"
      ) {
        return value.code;
      }
    }
  }
  return undefined;
}

describe("Tool authorization", () => {
  it("uses a synchronous non-Promise YOLO decision", () => {
    const decision = yoloToolAuthorizer.authorize(
      { id: "call", toolId: "demo/tool", arguments: {} },
      {
        sessionId: "session",
        turnId: "turn",
        stepId: "step",
        callId: "call",
        signal: new AbortController().signal,
      },
    );

    expect(decision).toEqual({ status: "allow" });
    expect(decision).not.toBeInstanceOf(Promise);
  });

  it("adds no model-visible work or Journal batch on the YOLO path", async () => {
    const journal = new RecordingJournal();
    let modelCalls = 0;
    let toolCalls = 0;
    const model: ModelAdapter = {
      id: "scripted/authorization-yolo-structure",
      async *generate(request) {
        modelCalls += 1;
        expect(request.tools).toEqual([{
          id: "demo/yolo",
          description: "One unchanged Tool schema.",
          inputSchema: { type: "object", additionalProperties: false },
        }]);
        if (modelCalls === 1) {
          yield {
            type: "tool-call",
            call: { id: "yolo", toolId: "demo/yolo", arguments: {} },
          };
        } else {
          yield { type: "text-delta", delta: "done" };
        }
        yield { type: "response-completed" };
      },
    };
    const capabilities: Plugin.Object<void> = {
      name: "test/authorization-yolo-structure",
      inject: ["models", "tools"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.tools.register({
          id: "demo/yolo",
          description: "One unchanged Tool schema.",
          inputSchema: { type: "object", additionalProperties: false },
          async execute() {
            toolCalls += 1;
            return { status: "success", content: [] };
          },
        });
      },
    };
    const kernel = await createKernel({ journal, plugins: [capabilities] });

    try {
      const agent = await kernel.createAgent({
        id: "authorization-yolo-structure",
        model: { adapter: model.id, model: "scripted" },
        tools: ["demo/yolo"],
      });
      const session = await kernel.createSession({
        id: "authorization-yolo-structure",
        agentId: agent.id,
      });

      await expect(
        session.send({ content: [{ type: "text", text: "run" }] }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(modelCalls).toBe(2);
      expect(toolCalls).toBe(1);
      expect(journal.batches).toHaveLength(14);
      expect(journal.batches).not.toContainEqual([
        "tool/authorization-requested",
      ]);
      expect(journal.batches).toContainEqual(["tool/call-started"]);
      expect(journal.batches).toContainEqual([
        "tool/call-completed",
        "step/completed",
      ]);
    } finally {
      await kernel.dispose();
    }
  });

  it("returns a denial to the model without executing the Tool", async () => {
    let executed = false;
    const model: ModelAdapter = {
      id: "scripted/authorization-deny",
      async *generate(request) {
        const code = authorizationError(request);
        if (code) {
          yield { type: "text-delta", delta: `handled ${code}` };
        } else {
          yield {
            type: "tool-call",
            call: {
              id: "call-write",
              toolId: "demo/write",
              arguments: { value: "changed" },
            },
          };
        }
        yield { type: "response-completed" };
      },
    };
    const tool: ToolDefinition = {
      id: "demo/write",
      description: "Record one value.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      async execute() {
        executed = true;
        return { status: "success", content: [] };
      },
    };
    const authorizer: ToolAuthorizer = {
      id: "test/deny",
      revision: 4,
      authorize() {
        return { status: "deny", reason: "write not approved" };
      },
    };
    const capabilities: Plugin.Object<void> = {
      name: "test/authorization-deny",
      inject: ["models", "tools"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.tools.register(tool);
      },
    };
    const kernel = await createKernel({
      plugins: [capabilities],
      toolAuthorizer: authorizer,
    });

    try {
      const agent = await kernel.createAgent({
        id: "authorization-deny",
        model: { adapter: model.id, model: "scripted" },
        tools: [tool.id],
      });
      const session = await kernel.createSession({
        id: "authorization-deny",
        agentId: agent.id,
      });

      const result = await session.send({
        content: [{ type: "text", text: "change it" }],
      });

      expect(result).toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "handled TOOL_AUTHORIZATION_DENIED" }],
      });
      expect(executed).toBe(false);
      const started = (await session.events()).find(
        (event) => event.type === "turn/started",
      );
      expect(started?.payload).toMatchObject({
        agent: {
          toolAuthorizer: { id: "test/deny", revision: 4 },
        },
      });
    } finally {
      await kernel.dispose();
    }
  });

  it("executes an allowed sibling while another ToolCall awaits authorization", async () => {
    const releaseSlow = deferred<{ readonly status: "allow" }>();
    const fastExecuted = deferred<void>();
    let modelCalls = 0;
    const model: ModelAdapter = {
      id: "scripted/authorization-parallel",
      async *generate() {
        modelCalls += 1;
        if (modelCalls === 1) {
          yield {
            type: "tool-call",
            call: { id: "slow", toolId: "demo/slow", arguments: {} },
          };
          yield {
            type: "tool-call",
            call: { id: "fast", toolId: "demo/fast", arguments: {} },
          };
        } else {
          yield { type: "text-delta", delta: "done" };
        }
        yield { type: "response-completed" };
      },
    };
    const tool = (id: string): ToolDefinition => ({
      id,
      description: id,
      inputSchema: { type: "object", additionalProperties: false },
      async execute() {
        if (id === "demo/fast") fastExecuted.resolve();
        return { status: "success", content: [{ type: "text", text: id }] };
      },
    });
    const capabilities: Plugin.Object<void> = {
      name: "test/authorization-parallel",
      inject: ["models", "tools"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.tools.register(tool("demo/slow"));
        ctx.tools.register(tool("demo/fast"));
      },
    };
    const kernel = await createKernel({
      plugins: [capabilities],
      toolAuthorizer: {
        id: "test/parallel",
        revision: 1,
        authorize(call) {
          return call.id === "slow" ? releaseSlow.promise : { status: "allow" };
        },
      },
    });

    try {
      const agent = await kernel.createAgent({
        id: "authorization-parallel",
        model: { adapter: model.id, model: "scripted" },
        tools: ["demo/slow", "demo/fast"],
      });
      const session = await kernel.createSession({
        id: "authorization-parallel",
        agentId: agent.id,
      });

      const turn = session.send({ content: [{ type: "text", text: "run" }] });
      await fastExecuted.promise;
      releaseSlow.resolve({ status: "allow" });

      await expect(turn).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "done" }],
      });
      const completed = (await session.events()).filter(
        (event) => event.type === "tool/call-completed",
      );
      expect(completed.map((event) => {
        if (event.payload.type !== "tool/call-completed") return undefined;
        return event.payload.result.callId;
      })).toEqual(["slow", "fast"]);
    } finally {
      await kernel.dispose();
    }
  });

  it("cancels a Turn while its Tool Authorizer is pending", async () => {
    const authorizationStarted = deferred<void>();
    let executed = false;
    const model: ModelAdapter = {
      id: "scripted/authorization-cancel",
      async *generate() {
        yield {
          type: "tool-call",
          call: { id: "pending", toolId: "demo/pending", arguments: {} },
        };
        yield { type: "response-completed" };
      },
    };
    const capabilities: Plugin.Object<void> = {
      name: "test/authorization-cancel",
      inject: ["models", "tools"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.tools.register({
          id: "demo/pending",
          description: "Never authorized.",
          inputSchema: { type: "object", additionalProperties: false },
          async execute() {
            executed = true;
            return { status: "success", content: [] };
          },
        });
      },
    };
    const kernel = await createKernel({
      plugins: [capabilities],
      toolAuthorizer: {
        id: "test/pending",
        revision: 1,
        authorize() {
          authorizationStarted.resolve();
          return new Promise(() => undefined);
        },
      },
    });

    try {
      const agent = await kernel.createAgent({
        id: "authorization-cancel",
        model: { adapter: model.id, model: "scripted" },
        tools: ["demo/pending"],
      });
      const session = await kernel.createSession({
        id: "authorization-cancel",
        agentId: agent.id,
      });

      const turn = session.send({ content: [{ type: "text", text: "run" }] });
      await authorizationStarted.promise;
      expect(session.cancelActiveTurn("stop authorization")).toBe(true);

      await expect(turn).resolves.toMatchObject({ status: "cancelled" });
      expect(executed).toBe(false);
    } finally {
      await kernel.dispose();
    }
  });

  it("returns an Authorizer failure to the model without executing the Tool", async () => {
    let executed = false;
    let siblingExecuted = false;
    const model: ModelAdapter = {
      id: "scripted/authorization-failure",
      async *generate(request) {
        const code = authorizationError(request);
        if (code) {
          yield { type: "text-delta", delta: code };
        } else {
          yield {
            type: "tool-call",
            call: { id: "failing", toolId: "demo/failing", arguments: {} },
          };
          yield {
            type: "tool-call",
            call: { id: "sibling", toolId: "demo/sibling", arguments: {} },
          };
        }
        yield { type: "response-completed" };
      },
    };
    const capabilities: Plugin.Object<void> = {
      name: "test/authorization-failure",
      inject: ["models", "tools"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.tools.register({
          id: "demo/failing",
          description: "Must not run.",
          inputSchema: { type: "object", additionalProperties: false },
          async execute() {
            executed = true;
            return { status: "success", content: [] };
          },
        });
        ctx.tools.register({
          id: "demo/sibling",
          description: "Must still run.",
          inputSchema: { type: "object", additionalProperties: false },
          async execute() {
            siblingExecuted = true;
            return { status: "success", content: [] };
          },
        });
      },
    };
    const kernel = await createKernel({
      plugins: [capabilities],
      toolAuthorizer: {
        id: "test/failure",
        revision: 1,
        authorize(call) {
          if (call.toolId === "demo/sibling") return { status: "allow" };
          throw new Error("approval channel failed");
        },
      },
    });

    try {
      const agent = await kernel.createAgent({
        id: "authorization-failure",
        model: { adapter: model.id, model: "scripted" },
        tools: ["demo/failing", "demo/sibling"],
      });
      const session = await kernel.createSession({
        id: "authorization-failure",
        agentId: agent.id,
      });

      await expect(
        session.send({ content: [{ type: "text", text: "run" }] }),
      ).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "TOOL_AUTHORIZER_FAILED" }],
      });
      expect(executed).toBe(false);
      expect(siblingExecuted).toBe(true);
    } finally {
      await kernel.dispose();
    }
  });

  it("replays a legacy AgentSnapshot without a Tool Authorizer ref", async () => {
    const currentJournal = new MemorySessionJournal();
    const model = (id: string): ModelAdapter => ({
      id,
      async *generate() {
        yield { type: "text-delta", delta: "done" };
        yield { type: "response-completed" };
      },
    });
    const plugin = (adapter: ModelAdapter): Plugin.Object<void> => ({
      name: `test/${adapter.id}`,
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(adapter);
      },
    });
    const firstModel = model("scripted/authorization-legacy");
    const firstKernel = await createKernel({
      journal: currentJournal,
      plugins: [plugin(firstModel)],
    });

    try {
      const agent = await firstKernel.createAgent({
        id: "authorization-legacy",
        model: { adapter: firstModel.id, model: "scripted" },
      });
      const session = await firstKernel.createSession({
        id: "authorization-legacy",
        agentId: agent.id,
      });
      await session.send({ content: [{ type: "text", text: "first" }] });
    } finally {
      await firstKernel.dispose();
    }

    const legacyJournal = new MemorySessionJournal();
    const legacyEvents = (await currentJournal.read("authorization-legacy")).map(
      (envelope) => {
        const event = envelope.payload;
        if (event.type !== "turn/started") return event;
        const { toolAuthorizer: _removed, ...legacyAgent } = event.agent;
        return { ...event, agent: legacyAgent };
      },
    );
    await legacyJournal.append("authorization-legacy", 0, legacyEvents);

    const resumedModel = model("scripted/authorization-legacy");
    const resumedKernel = await createKernel({
      journal: legacyJournal,
      plugins: [plugin(resumedModel)],
    });
    try {
      await resumedKernel.createAgent({
        id: "authorization-legacy",
        model: { adapter: resumedModel.id, model: "scripted" },
      });
      const session = await resumedKernel.openSession({
        id: "authorization-legacy",
      });

      await expect(
        session.send({ content: [{ type: "text", text: "second" }] }),
      ).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "done" }],
      });
    } finally {
      await resumedKernel.dispose();
    }
  });
});
