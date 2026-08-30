import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "cordis";
import { describe, expect, it } from "vitest";

import {
  createKernel,
  JsonlSessionJournal,
  type ModelAdapter,
  type ModelRequest,
  type SessionEvent,
} from "../src/index.js";

function latestUserText(request: ModelRequest): string {
  const latest = request.messages
    .filter((message) => message.role === "user")
    .at(-1);
  const text = latest?.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") throw new Error("missing user text");
  return text.text;
}

function modelPlugin(model: ModelAdapter): Plugin.Object<void> {
  return {
    name: `test/${model.id}`,
    inject: ["models"],
    apply(ctx) {
      ctx.models.register(model);
    },
  };
}

describe("durable Sessions", () => {
  it("replays the same SessionSnapshot from a new JSONL Adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nervus-journal-"));
    const model: ModelAdapter = {
      id: "scripted/durable",
      async *generate(request) {
        yield {
          type: "text-delta",
          delta: `persisted:${latestUserText(request)}`,
        };
        yield { type: "response-completed" };
      },
    };

    try {
      const firstKernel = await createKernel({
        journal: new JsonlSessionJournal({ directory }),
        plugins: [modelPlugin(model)],
      });
      const firstAgent = await firstKernel.createAgent({
        id: "durable-agent",
        model: { adapter: model.id, model: "scripted" },
      });
      const firstSession = await firstKernel.createSession({
        id: "durable-session",
        agentId: firstAgent.id,
      });
      await firstSession.send({
        content: [{ type: "text", text: "hello" }],
      });
      const beforeRestart = await firstSession.snapshot();
      await firstKernel.dispose();

      const secondKernel = await createKernel({
        journal: new JsonlSessionJournal({ directory }),
        plugins: [modelPlugin(model)],
      });
      try {
        await secondKernel.createAgent({
          id: "durable-agent",
          model: { adapter: model.id, model: "scripted" },
        });
        const recovered = await secondKernel.openSession({
          id: "durable-session",
        });
        const afterRestart = await recovered.snapshot();

        expect(afterRestart).toEqual(beforeRestart);
        expect(afterRestart).toMatchObject({
          id: "durable-session",
          agentId: "durable-agent",
          pendingInputCount: 0,
          turnCount: 1,
          latestTurn: {
            status: "completed",
            output: [{ type: "text", text: "persisted:hello" }],
          },
        });
        expect((await recovered.events()).map((event) => event.sequence)).toEqual(
          Array.from(
            { length: afterRestart.revision },
            (_value, index) => index + 1,
          ),
        );
      } finally {
        await secondKernel.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks an active Turn interrupted and explicitly resumes queued Inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nervus-recovery-"));
    const journal = new JsonlSessionJournal({ directory });
    const model: ModelAdapter = {
      id: "scripted/recovery",
      async *generate(request) {
        yield {
          type: "text-delta",
          delta: `recovered:${latestUserText(request)}`,
        };
        yield { type: "response-completed" };
      },
    };
    const kernel = await createKernel({
      journal,
      plugins: [modelPlugin(model)],
    });

    try {
      const agent = await kernel.createAgent({
        id: "recovery-agent",
        model: { adapter: model.id, model: "scripted" },
      });
      const activeContent = [{ type: "text", text: "do not repeat" }] as const;
      const queuedContent = [{ type: "text", text: "queued" }] as const;
      const seed: readonly SessionEvent[] = [
        { type: "session/created", agentId: agent.id },
        {
          type: "input/accepted",
          inputId: "active-input",
          content: activeContent,
        },
        {
          type: "turn/started",
          turnId: "interrupted-turn",
          inputId: "active-input",
          agent: agent.createSnapshot(),
        },
        {
          type: "user/message",
          turnId: "interrupted-turn",
          content: activeContent,
        },
        {
          type: "step/started",
          turnId: "interrupted-turn",
          stepId: "interrupted-step",
          index: 1,
        },
        {
          type: "tool/call-started",
          stepId: "interrupted-step",
          call: {
            id: "interrupted-tool",
            toolId: "historical/tool",
            arguments: {},
          },
        },
        {
          type: "input/accepted",
          inputId: "queued-input",
          content: queuedContent,
        },
      ];
      await journal.append("recovery-session", 0, seed);

      const session = await kernel.openSession({ id: "recovery-session" });
      expect(await session.snapshot()).toMatchObject({
        pendingInputCount: 1,
        turnCount: 1,
        latestTurn: { id: "interrupted-turn", status: "interrupted" },
      });
      expect(
        (await session.events()).filter(
          (event) => event.type === "turn/started",
        ),
      ).toHaveLength(1);
      expect(
        (await session.events()).filter(
          (event) => event.type === "tool/call-interrupted",
        ),
      ).toMatchObject([
        { payload: { callId: "interrupted-tool" } },
      ]);

      await expect(session.resumePendingInputs()).resolves.toMatchObject([
        {
          status: "completed",
          output: [{ type: "text", text: "recovered:queued" }],
        },
      ]);
      expect(await session.snapshot()).toMatchObject({
        pendingInputCount: 0,
        turnCount: 2,
        latestTurn: {
          status: "completed",
          output: [{ type: "text", text: "recovered:queued" }],
        },
      });
    } finally {
      await kernel.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a stale revision without partially appending its batch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nervus-revision-"));
    const journal = new JsonlSessionJournal({ directory });

    try {
      await journal.append("revision-session", 0, [
        { type: "session/created", agentId: "revision-agent" },
      ]);
      const first = journal.append("revision-session", 1, [
        {
          type: "input/accepted",
          inputId: "first-batch-a",
          content: [{ type: "text", text: "a" }],
        },
        {
          type: "input/accepted",
          inputId: "first-batch-b",
          content: [{ type: "text", text: "b" }],
        },
      ]);
      const stale = journal.append("revision-session", 1, [
        {
          type: "input/accepted",
          inputId: "stale-batch",
          content: [{ type: "text", text: "stale" }],
        },
      ]);

      await expect(first).resolves.toHaveLength(2);
      await expect(stale).rejects.toThrow(
        "session revision conflict: expected 1, actual 3",
      );
      const events = await journal.read("revision-session");
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(
        events.some(
          (event) =>
            event.payload.type === "input/accepted" &&
            event.payload.inputId === "stale-batch",
        ),
      ).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks an unterminated ModelCall interrupted during recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nervus-model-recovery-"));
    const journal = new JsonlSessionJournal({ directory });
    const model: ModelAdapter = {
      id: "scripted/model-recovery",
      async *generate() {
        yield { type: "response-completed" };
      },
    };
    const kernel = await createKernel({
      journal,
      plugins: [modelPlugin(model)],
    });

    try {
      const agent = await kernel.createAgent({
        id: "model-recovery-agent",
        model: { adapter: model.id, model: "scripted" },
      });
      const snapshot = agent.createSnapshot();
      await journal.append("model-recovery-session", 0, [
        { type: "session/created", agentId: agent.id },
        {
          type: "input/accepted",
          inputId: "model-recovery-input",
          content: [{ type: "text", text: "recover model" }],
        },
        {
          type: "turn/started",
          turnId: "model-recovery-turn",
          inputId: "model-recovery-input",
          agent: snapshot,
        },
        {
          type: "user/message",
          turnId: "model-recovery-turn",
          content: [{ type: "text", text: "recover model" }],
        },
        {
          type: "step/started",
          turnId: "model-recovery-turn",
          stepId: "model-recovery-step",
          index: 1,
        },
        {
          type: "model/call-started",
          stepId: "model-recovery-step",
          modelCallId: "interrupted-model-call",
          snapshot: {
            request: {
              model: "scripted",
              instructions: [],
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: "recover model" }],
                },
              ],
              tools: [],
            },
            blocks: [],
            report: {
              inputBudget: 100,
              estimatedInputTokens: 3,
              includedBlockIds: [],
              dropped: [],
              truncated: [],
            },
          },
        },
      ]);

      const session = await kernel.openSession({ id: "model-recovery-session" });
      expect(
        (await session.events()).filter(
          (event) => event.type === "model/call-interrupted",
        ),
      ).toMatchObject([
        { payload: { modelCallId: "interrupted-model-call" } },
      ]);
      expect(await session.snapshot()).toMatchObject({
        latestTurn: { status: "interrupted" },
      });
    } finally {
      await kernel.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
