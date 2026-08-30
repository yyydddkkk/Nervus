import type { Plugin } from "cordis";
import { describe, expect, it } from "vitest";

import {
  createKernel,
  MemorySessionJournal,
  type ModelAdapter,
  type ModelRequest,
} from "../src/index.js";

const FIRST_INPUT = "A".repeat(52);
const FIRST_OUTPUT = "B".repeat(52);
const SECOND_INPUT = "C".repeat(140);
const THIRD_INPUT = "after restart";

function text(blocks: ModelRequest["instructions"]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

function latestUserText(request: ModelRequest): string {
  const message = request.messages.filter((item) => item.role === "user").at(-1);
  const block = message?.content.find((item) => item.type === "text");
  return block?.type === "text" ? block.text : "";
}

describe("Automatic history Compaction", () => {
  it("durably summarizes prior Turns before Context would drop them", async () => {
    const journal = new MemorySessionJournal();
    const requests: ModelRequest[] = [];
    const model: ModelAdapter = {
      id: "scripted/compaction",
      capabilities: { contextWindow: 70, maxOutputTokens: 10 },
      async *generate(request) {
        requests.push(request);
        if (text(request.instructions).includes("Summarize this history")) {
          expect(request.tools).toEqual([]);
          expect(request.messages.some((message) =>
            message.content.some(
              (block) => block.type === "text" && block.text === FIRST_INPUT,
            ),
          )).toBe(true);
          yield {
            type: "text-delta",
            delta: "Earlier session summary: A then B.",
          };
        } else if (latestUserText(request) === FIRST_INPUT) {
          yield { type: "text-delta", delta: FIRST_OUTPUT };
        } else if (latestUserText(request) === SECOND_INPUT) {
          expect(text(request.instructions)).toContain(
            "Earlier session summary: A then B.",
          );
          expect(request.messages).toHaveLength(1);
          expect(latestUserText(request)).toBe(SECOND_INPUT);
          yield { type: "text-delta", delta: "continued from summary" };
        } else {
          expect(latestUserText(request)).toBe(THIRD_INPUT);
          expect(text(request.instructions)).toContain(
            "Earlier session summary: A then B.",
          );
          expect(
            request.messages.some((message) =>
              message.content.some(
                (block) => block.type === "text" && block.text === FIRST_INPUT,
              ),
            ),
          ).toBe(false);
          expect(
            request.messages.some((message) =>
              message.content.some(
                (block) => block.type === "text" && block.text === SECOND_INPUT,
              ),
            ),
          ).toBe(true);
          yield { type: "text-delta", delta: "resumed from compacted history" };
        }
        yield { type: "response-completed" };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/compaction-model",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({ journal, plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "compaction-agent",
        model: { adapter: model.id, model: "scripted" },
      });
      const session = await kernel.createSession({
        id: "compaction-session",
        agentId: agent.id,
      });
      await expect(
        session.send({ content: [{ type: "text", text: FIRST_INPUT }] }),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(
        session.send({ content: [{ type: "text", text: SECOND_INPUT }] }),
      ).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "continued from summary" }],
      });

      expect(requests).toHaveLength(3);
      const events = await session.events();
      const compacted = events.find(
        (event) => event.payload.type === "history/compacted",
      );
      expect(compacted?.payload).toMatchObject({
        type: "history/compacted",
        summary: [{ type: "text", text: "Earlier session summary: A then B." }],
      });
      if (!compacted || compacted.payload.type !== "history/compacted") {
        throw new Error("missing Compaction event");
      }
      const compactionModelCallId = compacted.payload.modelCallId;
      expect(compacted.payload.throughSequence).toBeLessThan(compacted.sequence);
      expect(
        events.some(
          (event) =>
            event.payload.type === "model/call-completed" &&
            event.payload.modelCallId === compactionModelCallId,
        ),
      ).toBe(true);
      const finalCall = events
        .filter((event) => event.payload.type === "model/call-started")
        .at(-1);
      if (!finalCall || finalCall.payload.type !== "model/call-started") {
        throw new Error("missing final ModelCall");
      }
      expect(finalCall.payload.snapshot.report.needsCompaction).toBe(false);
      expect(finalCall.payload.snapshot.report.includedBlockIds).toContain(
        "history/summary",
      );

      await kernel.dispose();
      const restarted = await createKernel({ journal, plugins: [plugin] });
      try {
        await restarted.createAgent({
          id: "compaction-agent",
          model: { adapter: model.id, model: "scripted" },
        });
        const reopened = await restarted.openSession({
          id: "compaction-session",
        });
        await expect(
          reopened.send({ content: [{ type: "text", text: THIRD_INPUT }] }),
        ).resolves.toMatchObject({
          status: "completed",
          output: [
            { type: "text", text: "resumed from compacted history" },
          ],
        });
      } finally {
        await restarted.dispose();
      }
    } finally {
      await kernel.dispose();
    }
  });

  it("fails the Turn instead of silently dropping history when Compaction fails", async () => {
    const model: ModelAdapter = {
      id: "scripted/compaction-failure",
      capabilities: { contextWindow: 70, maxOutputTokens: 10 },
      async *generate(request) {
        if (text(request.instructions).includes("Summarize this history")) {
          yield {
            type: "response-failed",
            error: "summary unavailable",
            retryable: false,
          };
          return;
        }
        if (latestUserText(request) === FIRST_INPUT) {
          yield { type: "text-delta", delta: FIRST_OUTPUT };
          yield { type: "response-completed" };
          return;
        }
        throw new Error("the main ModelCall must not run without prior history");
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/compaction-failure-model",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "compaction-failure-agent",
        model: { adapter: model.id, model: "scripted" },
      });
      const session = await kernel.createSession({
        id: "compaction-failure-session",
        agentId: agent.id,
      });
      await session.send({ content: [{ type: "text", text: FIRST_INPUT }] });
      await expect(
        session.send({ content: [{ type: "text", text: SECOND_INPUT }] }),
      ).resolves.toMatchObject({ status: "failed" });

      const events = await session.events();
      expect(events.some((event) => event.type === "history/compacted")).toBe(
        false,
      );
      expect(events.at(-1)?.payload).toMatchObject({
        type: "turn/failed",
        error: "summary unavailable",
      });
    } finally {
      await kernel.dispose();
    }
  });

  it("counts Compaction attempts against the Turn model-attempt limit", async () => {
    let callCount = 0;
    const model: ModelAdapter = {
      id: "scripted/compaction-limit",
      capabilities: { contextWindow: 70, maxOutputTokens: 10 },
      async *generate(request) {
        callCount += 1;
        yield {
          type: "text-delta",
          delta: text(request.instructions).includes("Summarize this history")
            ? "bounded summary"
            : FIRST_OUTPUT,
        };
        yield { type: "response-completed" };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/compaction-limit-model",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "compaction-limit-agent",
        model: { adapter: model.id, model: "scripted" },
        limits: { maxModelAttempts: 1 },
      });
      const session = await kernel.createSession({
        id: "compaction-limit-session",
        agentId: agent.id,
      });
      await session.send({ content: [{ type: "text", text: FIRST_INPUT }] });
      await expect(
        session.send({ content: [{ type: "text", text: SECOND_INPUT }] }),
      ).resolves.toMatchObject({ status: "exhausted" });

      expect(callCount).toBe(2);
      expect(
        (await session.events()).some(
          (event) => event.type === "history/compacted",
        ),
      ).toBe(true);
    } finally {
      await kernel.dispose();
    }
  });
});
