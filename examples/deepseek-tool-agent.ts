import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { Plugin } from "cordis";

import {
  createKernel,
  JsonlSessionJournal,
  localToolsPlugin,
  OpenAICompatibleChatAdapter,
  type Kernel,
  type Session,
} from "../src/index.js";

const apiKey = requiredEnv("OPENAI_API_KEY");
const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.deepseek.com";
const modelName = process.env.OPENAI_MODEL ?? "deepseek-v4-flash";
const workspace = resolve(
  process.env.NERVUS_DEEPSEEK_WORKSPACE ?? ".nervus/deepseek-workspace",
);
const sessionDirectory = resolve(
  process.env.NERVUS_DEEPSEEK_SESSIONS ?? ".nervus/deepseek-sessions",
);
const sessionId =
  process.env.NERVUS_SESSION_ID ?? `deepseek-tool-${Date.now()}`;
const task =
  process.argv.slice(2).join(" ") ||
  [
    "Use the provided Tools to complete every step.",
    "Read input/project-notes.md.",
    "Run shell/run with `wc -w input/project-notes.md`.",
    "Write a concise Chinese summary to output/summary.md.",
    "Read output/summary.md back before giving the final answer.",
    "Do not claim completion unless all ToolResults succeeded.",
  ].join(" ");

await prepareWorkspace(workspace);
const journal = new JsonlSessionJournal({ directory: sessionDirectory });
const firstHost = await createHost(journal);
let session: Session | undefined;
let reasoningCharacters = 0;
let streamedText = "";

firstHost.context.on("model/reasoning-delta", (update) => {
  reasoningCharacters += update.delta.length;
});
firstHost.context.on("model/text-delta", (update) => {
  streamedText += update.delta;
  process.stdout.write(update.delta);
});

try {
  const agent = await firstHost.createAgent({
    id: "deepseek-tool-agent",
    model: {
      adapter: "deepseek/chat-completions",
      model: modelName,
      maxOutputTokens: 8_192,
    },
    instructions: [
      {
        type: "text",
        text: [
          "You are a Tool-using Agent operating inside a dedicated workspace.",
          "Use only relative paths and the provided Tools.",
          "Follow every requested read, shell, write, and verification step.",
          "Never fabricate ToolResults or claim a file exists without reading it back.",
        ].join(" "),
      },
    ],
    tools: ["fs/read", "fs/write", "shell/run"],
    limits: {
      maxSteps: 12,
      maxToolCalls: 20,
      maxToolCallsPerStep: 4,
      maxModelAttempts: 16,
    },
    timeouts: { modelMs: 300_000, toolMs: 30_000 },
  });
  session = await firstHost.createSession({ id: sessionId, agentId: agent.id });
  const result = await session.send({
    content: [{ type: "text", text: task }],
  });
  process.stdout.write("\n");
  if (result.status !== "completed") {
    throw new Error(`DeepSeek Tool Turn ended with status ${result.status}`);
  }

  const summaryPath = resolve(workspace, "output/summary.md");
  const summary = await readFile(summaryPath, "utf8");
  if (!summary.trim()) throw new Error("output/summary.md is empty");
  const beforeRestart = await session.snapshot();
  const events = await session.events();
  const eventCounts = countEventTypes(events.map((event) => event.type));
  const usage = events.reduce(
    (total, event) => {
      if (
        event.payload.type === "model/call-completed" &&
        event.payload.usage
      ) {
        total.inputTokens += event.payload.usage.inputTokens;
        total.outputTokens += event.payload.usage.outputTokens;
        total.totalTokens += event.payload.usage.totalTokens;
      }
      return total;
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );

  await firstHost.dispose();
  const recoveredHost = await createHost(journal);
  try {
    await recoveredHost.createAgent({
      id: "deepseek-tool-agent",
      model: {
        adapter: "deepseek/chat-completions",
        model: modelName,
        maxOutputTokens: 8_192,
      },
      tools: ["fs/read", "fs/write", "shell/run"],
    });
    const recovered = await recoveredHost.openSession({ id: sessionId });
    const afterRestart = await recovered.snapshot();
    if (
      afterRestart.revision !== beforeRestart.revision ||
      afterRestart.latestTurn?.status !== "completed"
    ) {
      throw new Error("Recovered SessionSnapshot does not match completed Turn");
    }
  } finally {
    await recoveredHost.dispose();
  }

  process.stderr.write(
    `${JSON.stringify(
      {
        sessionId,
        model: modelName,
        workspace,
        summaryPath,
        summaryBytes: Buffer.byteLength(summary, "utf8"),
        reasoningCharacters,
        streamedTextCharacters: streamedText.length,
        revision: beforeRestart.revision,
        turnStatus: beforeRestart.latestTurn?.status,
        eventCounts,
        usage,
        recovered: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (firstHost.state !== "disposed") await firstHost.dispose();
}

async function createHost(journal: JsonlSessionJournal): Promise<Kernel> {
  const adapter = new OpenAICompatibleChatAdapter({
    id: "deepseek/chat-completions",
    baseUrl,
    apiKey,
    compatibility: "deepseek",
    extraBody: {
      thinking: { type: "enabled" },
      reasoning_effort: process.env.DEEPSEEK_REASONING_EFFORT ?? "high",
    },
    capabilities: {
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
      safetyMarginTokens: 1_024,
      supportsTools: true,
      supportsImages: false,
    },
  });
  const modelPlugin: Plugin.Object<void> = {
    name: "example/deepseek-model",
    inject: ["models"],
    apply(ctx) {
      ctx.models.register(adapter);
    },
  };
  return createKernel({
    journal,
    plugins: [modelPlugin, localToolsPlugin({ root: workspace })],
    retry: { baseDelayMs: 500, maxDelayMs: 4_000 },
  });
}

async function prepareWorkspace(root: string): Promise<void> {
  const notesPath = resolve(root, "input/project-notes.md");
  await mkdir(dirname(notesPath), { recursive: true });
  await mkdir(resolve(root, "output"), { recursive: true });
  try {
    await access(notesPath);
  } catch {
    await writeFile(
      notesPath,
      [
        "# Nervus Project Notes",
        "Nervus is a TypeScript semantic kernel built on Cordis.",
        "It models AgentSpec, Session, Turn, Step, ModelCall, ToolCall, and ToolResult.",
        "SessionEvents are the source of truth and JSONL supports durable replay.",
        "ContextBlocks, Skills, bounded concurrency, cancellation, and retries are implemented.",
      ].join("\n"),
      "utf8",
    );
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in the local .env file`);
  return value;
}

function countEventTypes(types: readonly string[]): Record<string, number> {
  return types.reduce<Record<string, number>>((counts, type) => {
    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {});
}
