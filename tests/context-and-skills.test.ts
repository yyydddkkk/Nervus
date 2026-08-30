import type { Plugin } from "cordis";
import { describe, expect, it } from "vitest";

import {
  createKernel,
  type ContextContributor,
  type ModelAdapter,
  type ModelRequest,
  type SkillDefinition,
} from "../src/index.js";

function instructionTexts(request: ModelRequest): readonly string[] {
  return request.instructions
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""));
}

function latestUserText(request: ModelRequest): string {
  const latest = request.messages
    .filter((message) => message.role === "user")
    .at(-1);
  const text = latest?.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") throw new Error("missing user text");
  return text.text;
}

describe("Context and Skills", () => {
  it("assembles stable ContextBlock layers and records budget drops", async () => {
    const contributor: ContextContributor = {
      id: "test/context",
      revision: 3,
      async contribute() {
        return [
          {
            id: "memory/fact",
            source: "test/context",
            layer: "memory",
            order: 0,
            retention: "required",
            tokenEstimate: 2,
            content: {
              type: "instructions",
              blocks: [{ type: "text", text: "remembered fact" }],
            },
          },
          {
            id: "runtime/noise",
            source: "test/context",
            layer: "runtime",
            order: 0,
            retention: "optional",
            tokenEstimate: 100,
            content: {
              type: "instructions",
              blocks: [{ type: "text", text: "drop this noise" }],
            },
          },
        ];
      },
    };
    const model: ModelAdapter = {
      id: "scripted/context",
      capabilities: {
        contextWindow: 30,
        maxOutputTokens: 10,
      },
      async *generate(request) {
        expect(request.instructions).toEqual([
          { type: "text", text: "agent instructions" },
          { type: "text", text: "remembered fact" },
        ]);
        yield { type: "text-delta", delta: "assembled" };
        yield { type: "response-completed" };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/context-assembly",
      inject: ["models", "context"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.context.register(contributor);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "context-agent",
        model: { adapter: model.id, model: "scripted" },
        instructions: [{ type: "text", text: "agent instructions" }],
      });
      const session = await kernel.createSession({
        id: "context-session",
        agentId: agent.id,
      });
      await expect(
        session.send({ content: [{ type: "text", text: "assemble" }] }),
      ).resolves.toMatchObject({ status: "completed" });

      const started = (await session.events()).find(
        (event) => event.payload.type === "model/call-started",
      );
      if (!started || started.payload.type !== "model/call-started") {
        throw new Error("missing ModelCall start event");
      }
      expect(started.payload.snapshot.report).toMatchObject({
        inputBudget: 20,
        includedBlockIds: ["agent/instructions", "memory/fact", "history/messages"],
        dropped: [
          { id: "runtime/noise", reason: "input budget exceeded" },
        ],
      });
      const turnStarted = (await session.events()).find(
        (event) => event.payload.type === "turn/started",
      );
      if (!turnStarted || turnStarted.payload.type !== "turn/started") {
        throw new Error("missing Turn start event");
      }
      expect(turnStarted.payload.agent).toMatchObject({
        modelRevision: 1,
        contextContributors: [{ id: "test/context", revision: 3 }],
      });
    } finally {
      await kernel.dispose();
    }
  });

  it("activates an available Skill for only the remainder of one Turn", async () => {
    const eager: SkillDefinition = {
      id: "skills/eager",
      name: "Eager",
      description: "Always active.",
      instructions: [{ type: "text", text: "eager instructions" }],
    };
    const available: SkillDefinition = {
      id: "skills/available",
      name: "Available",
      description: "Load when the task needs specialist guidance.",
      instructions: [{ type: "text", text: "available full instructions" }],
    };
    const model: ModelAdapter = {
      id: "scripted/skills",
      async *generate(request) {
        const instructions = instructionTexts(request);
        expect(instructions).toContain("eager instructions");
        const input = latestUserText(request);
        const activated = request.messages.some(
          (message) =>
            message.role === "tool" && message.toolId === "skills/activate",
        );

        if (input === "first" && !activated) {
          expect(instructions).not.toContain("available full instructions");
          expect(
            instructions.some((text) =>
              text.includes("Load when the task needs specialist guidance."),
            ),
          ).toBe(true);
          expect(request.tools.map((tool) => tool.id)).toContain(
            "skills/activate",
          );
          yield {
            type: "tool-call",
            call: {
              id: "activate-available",
              toolId: "skills/activate",
              arguments: { skillId: available.id },
            },
          };
        } else if (input === "first") {
          expect(instructions).toContain("available full instructions");
          yield { type: "text-delta", delta: "skill active" };
        } else {
          expect(instructions).not.toContain("available full instructions");
          expect(
            instructions.some((text) =>
              text.includes("Load when the task needs specialist guidance."),
            ),
          ).toBe(true);
          yield { type: "text-delta", delta: "skill reset" };
        }
        yield { type: "response-completed" };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/skills",
      inject: ["models", "skills"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.skills.register(eager);
        ctx.skills.register(available);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "skills-agent",
        model: { adapter: model.id, model: "scripted" },
        skills: [
          { id: eager.id, mode: "eager" },
          { id: available.id, mode: "available" },
        ],
      });
      const session = await kernel.createSession({
        id: "skills-session",
        agentId: agent.id,
      });

      await expect(
        session.send({ content: [{ type: "text", text: "first" }] }),
      ).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "skill active" }],
      });
      expect(
        (await session.events()).some(
          (event) => event.type === "skill/activated",
        ),
      ).toBe(true);
      await expect(
        session.send({ content: [{ type: "text", text: "second" }] }),
      ).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "skill reset" }],
      });
    } finally {
      await kernel.dispose();
    }
  });

  it("uses a Model Adapter token counter to enforce the input budget", async () => {
    const contributor: ContextContributor = {
      id: "test/exact-tokens",
      contribute() {
        return [
          {
            id: "runtime/expensive",
            source: "test/exact-tokens",
            layer: "runtime",
            order: 0,
            retention: "optional",
            tokenEstimate: 1,
            content: {
              type: "instructions",
              blocks: [{ type: "text", text: "expensive" }],
            },
          },
        ];
      },
    };
    const model: ModelAdapter = {
      id: "scripted/exact-tokens",
      capabilities: {
        contextWindow: 30,
        maxOutputTokens: 10,
        countTokens(request) {
          return instructionTexts(request).includes("expensive") ? 100 : 5;
        },
      },
      async *generate(request) {
        expect(instructionTexts(request)).not.toContain("expensive");
        yield { type: "text-delta", delta: "exact" };
        yield { type: "response-completed" };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/exact-tokens",
      inject: ["models", "context"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.context.register(contributor);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "exact-token-agent",
        model: { adapter: model.id, model: "scripted" },
      });
      const session = await kernel.createSession({
        id: "exact-token-session",
        agentId: agent.id,
      });
      await expect(
        session.send({ content: [{ type: "text", text: "count" }] }),
      ).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "exact" }],
      });

      const started = (await session.events()).find(
        (event) => event.payload.type === "model/call-started",
      );
      if (!started || started.payload.type !== "model/call-started") {
        throw new Error("missing ModelCall start event");
      }
      expect(started.payload.snapshot.report).toMatchObject({
        estimatedInputTokens: 5,
        dropped: [
          { id: "runtime/expensive", reason: "input budget exceeded" },
        ],
      });
    } finally {
      await kernel.dispose();
    }
  });

  it("drops prior history without removing the current Turn messages", async () => {
    const model: ModelAdapter = {
      id: "scripted/current-turn-history",
      capabilities: {
        contextWindow: 30,
        maxOutputTokens: 10,
        countTokens(request) {
          const hasOldAssistant = request.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.content.some(
                (block) => block.type === "text" && block.text.startsWith("old:"),
              ),
          );
          return hasOldAssistant ? 100 : 5;
        },
      },
      async *generate(request) {
        const input = latestUserText(request);
        yield {
          type: "text-delta",
          delta: input === "first" ? `old:${"history ".repeat(20)}` : "current kept",
        };
        yield { type: "response-completed" };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/current-turn-history",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "current-turn-agent",
        model: { adapter: model.id, model: "scripted" },
      });
      const session = await kernel.createSession({
        id: "current-turn-session",
        agentId: agent.id,
      });
      await session.send({ content: [{ type: "text", text: "first" }] });
      await expect(
        session.send({ content: [{ type: "text", text: "second" }] }),
      ).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "current kept" }],
      });

      const starts = (await session.events()).filter(
        (event) => event.payload.type === "model/call-started",
      );
      const second = starts.at(-1);
      if (!second || second.payload.type !== "model/call-started") {
        throw new Error("missing second ModelRequestSnapshot");
      }
      expect(second.payload.snapshot.report).toMatchObject({
        includedBlockIds: ["agent/instructions", "history/messages"],
        dropped: [
          { id: "history/prior", reason: "input budget exceeded" },
        ],
      });
    } finally {
      await kernel.dispose();
    }
  });

  it("uses a ContextBlock truncator before dropping the whole Block", async () => {
    const contributor: ContextContributor = {
      id: "test/truncation",
      contribute() {
        return [
          {
            id: "memory/truncatable",
            source: "test/truncation",
            layer: "memory",
            order: 0,
            retention: "preferred",
            tokenEstimate: 20,
            content: {
              type: "instructions",
              blocks: [{ type: "text", text: "long memory" }],
            },
            truncate(targetTokens) {
              expect(targetTokens).toBeLessThan(20);
              return {
                type: "instructions",
                blocks: [{ type: "text", text: "short" }],
              };
            },
          },
        ];
      },
    };
    const model: ModelAdapter = {
      id: "scripted/truncation",
      capabilities: { contextWindow: 18, maxOutputTokens: 10 },
      async *generate(request) {
        expect(instructionTexts(request)).toContain("short");
        expect(instructionTexts(request)).not.toContain("long memory");
        yield { type: "text-delta", delta: "truncated" };
        yield { type: "response-completed" };
      },
    };
    const plugin: Plugin.Object<void> = {
      name: "test/truncation",
      inject: ["models", "context"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.context.register(contributor);
      },
    };
    const kernel = await createKernel({ plugins: [plugin] });

    try {
      const agent = await kernel.createAgent({
        id: "truncation-agent",
        model: { adapter: model.id, model: "scripted" },
      });
      const session = await kernel.createSession({
        id: "truncation-session",
        agentId: agent.id,
      });
      await session.send({ content: [{ type: "text", text: "truncate" }] });
      const started = (await session.events()).find(
        (event) => event.payload.type === "model/call-started",
      );
      if (!started || started.payload.type !== "model/call-started") {
        throw new Error("missing ModelRequestSnapshot");
      }
      expect(started.payload.snapshot.report).toMatchObject({
        truncated: [
          { id: "memory/truncatable", fromTokens: 20, toTokens: 2 },
        ],
        dropped: [],
      });
    } finally {
      await kernel.dispose();
    }
  });
});
