import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { Plugin } from "cordis";

import { OpenAICompatibleChatAdapter } from "../adapters/openai-compatible.js";
import type { ModelAdapter } from "../models/model.js";
import { createKernel } from "../kernel/kernel.js";
import { JsonlSessionJournal } from "../sessions/jsonl-journal.js";
import { projectSession } from "../sessions/projection.js";
import type { Session } from "../sessions/session.js";
import { localToolsPlugin } from "../tools/local.js";

export interface CliIO {
  write(text: string): void;
  writeError(text: string): void;
  readLines(): AsyncIterable<string>;
  onInterrupt(handler: () => void): () => void;
  closeInput?(): void;
}

export interface RunNervusCliOptions {
  readonly io: CliIO;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly modelAdapter?: ModelAdapter;
}

interface ParsedOptions {
  readonly workspace: string;
  readonly sessionsDirectory: string;
  readonly sessionId?: string;
  readonly createNew: boolean;
  readonly prompt: string;
}

export async function runNervusCli(
  argv: readonly string[],
  options: RunNervusCliOptions,
): Promise<number> {
  try {
    const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
    const [command, subcommand] = normalizedArgv;
    if (command === "chat") {
      return runChat(parseOptions(normalizedArgv.slice(1)), options);
    }
    if (command === "sessions" && subcommand === "resume") {
      const sessionId = normalizedArgv[2];
      if (!sessionId) throw new Error("sessions resume requires a Session ID");
      return runChat(
        parseOptions(normalizedArgv.slice(3), { sessionId }),
        options,
      );
    }
    if (command === "sessions" && subcommand === "list") {
      const parsed = parseOptions(normalizedArgv.slice(2));
      const journal = new JsonlSessionJournal({
        directory: parsed.sessionsDirectory,
      });
      for (const sessionId of await journal.list()) {
        options.io.write(`${sessionId}\n`);
      }
      return 0;
    }
    if (command === "sessions" && subcommand === "inspect") {
      const sessionId = normalizedArgv[2];
      if (!sessionId) throw new Error("sessions inspect requires a Session ID");
      const parsed = parseOptions(normalizedArgv.slice(3), { sessionId });
      const journal = new JsonlSessionJournal({
        directory: parsed.sessionsDirectory,
      });
      const events = await journal.read(sessionId);
      if (events.length === 0) throw new Error(`Session does not exist: ${sessionId}`);
      const snapshot = projectSession(sessionId, events);
      options.io.write(
        `${JSON.stringify(
          {
            snapshot,
            eventCounts: countValues(events.map((event) => event.type)),
            usage: collectUsage(events),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    writeUsage(options.io);
    return command ? 1 : 0;
  } catch (error) {
    options.io.writeError(`${formatError(error)}\n`);
    return 1;
  }
}

async function runChat(
  parsed: ParsedOptions,
  options: RunNervusCliOptions,
): Promise<number> {
  await mkdir(parsed.workspace, { recursive: true });
  const env = options.env ?? process.env;
  const model = options.modelAdapter ?? createEnvironmentModel(env);
  const modelName = options.modelAdapter
    ? env.OPENAI_MODEL ?? "scripted"
    : requiredValue(env, "OPENAI_MODEL");
  const journal = new JsonlSessionJournal({
    directory: parsed.sessionsDirectory,
  });
  const modelPlugin: Plugin.Object<void> = {
    name: "nervus/cli-model",
    inject: ["models"],
    apply(ctx) {
      ctx.models.register(model);
    },
  };
  const kernel = await createKernel({
    journal,
    plugins: [modelPlugin, localToolsPlugin({ root: parsed.workspace })],
  });
  let session: Session | undefined;
  let active = false;
  let exitRequested = false;
  let reasoningCharacters = 0;
  const announcedCompactions = new Set<string>();
  const removeTextListener = kernel.context.on("model/text-delta", (update) => {
    if (update.purpose === "compaction") {
      if (!announcedCompactions.has(update.modelCallId)) {
        announcedCompactions.add(update.modelCallId);
        options.io.writeError("[compacting history]\n");
      }
      return;
    }
    options.io.write(update.delta);
  });
  const removeReasoningListener = kernel.context.on(
    "model/reasoning-delta",
    (update) => {
      if (update.purpose === "compaction") return;
      reasoningCharacters += update.delta.length;
    },
  );
  const removeProgressListener = kernel.context.on("tool/progress", (update) => {
    options.io.writeError(
      `[progress ${update.toolId}] ${contentText(update.content)}\n`,
    );
  });
  const removeInterrupt = options.io.onInterrupt(() => {
    if (active && session?.cancelActiveTurn("CLI interrupt")) {
      options.io.writeError("\n[cancelled active Turn]\n");
      return;
    }
    exitRequested = true;
    options.io.closeInput?.();
  });

  try {
    const agent = await kernel.createAgent({
      id: "nervus-cli-agent",
      model: { adapter: model.id, model: modelName, maxOutputTokens: 8_192 },
      instructions: [
        {
          type: "text",
          text: [
            "You are a Tool-using Agent operating in an explicit workspace.",
            "Use relative paths, inspect evidence before making claims, and report Tool failures honestly.",
          ].join(" "),
        },
      ],
      tools: ["fs/read", "fs/write", "shell/run"],
      limits: {
        maxSteps: 24,
        maxToolCalls: 64,
        maxToolCallsPerStep: 8,
        maxModelAttempts: 32,
      },
      timeouts: { modelMs: 300_000, toolMs: 60_000 },
    });
    const sessionId = parsed.sessionId ?? `session-${randomUUID()}`;
    const exists = (await journal.list()).includes(sessionId);
    if (parsed.createNew && exists) {
      throw new Error(`Session already exists: ${sessionId}`);
    }
    session = exists
      ? await kernel.openSession({ id: sessionId })
      : await kernel.createSession({ id: sessionId, agentId: agent.id });
    options.io.writeError(`[session ${sessionId}]\n`);

    if (parsed.prompt) {
      return (await executeInput(session, parsed.prompt)) ? 0 : 1;
    }

    options.io.write("nervus> ");
    for await (const line of options.io.readLines()) {
      if (exitRequested) break;
      const input = line.trim();
      if (!input) {
        options.io.write("nervus> ");
        continue;
      }
      if (input === "/exit" || input === "exit") break;
      await executeInput(session, input);
      if (!exitRequested) options.io.write("nervus> ");
    }
    return 0;
  } finally {
    removeInterrupt();
    removeProgressListener();
    removeReasoningListener();
    removeTextListener();
    await kernel.dispose();
  }

  async function executeInput(target: Session, input: string): Promise<boolean> {
    active = true;
    reasoningCharacters = 0;
    const before = (await target.events()).length;
    try {
      const result = await target.send({
        content: [{ type: "text", text: input }],
      });
      options.io.write("\n");
      const events = (await target.events()).slice(before);
      const toolCalls = events.filter(
        (event) => event.type === "tool/call-started",
      ).length;
      const toolErrors = events.filter(
        (event) =>
          event.payload.type === "tool/call-completed" &&
          event.payload.result.status === "error",
      ).length;
      const failure = [...events].reverse().find(
        (event) =>
          event.payload.type === "turn/failed" ||
          event.payload.type === "turn/cancelled" ||
          event.payload.type === "turn/exhausted",
      );
      if (failure?.payload.type === "turn/failed") {
        options.io.writeError(`[error] ${failure.payload.error}\n`);
      } else if (failure?.payload.type === "turn/cancelled") {
        options.io.writeError(`[cancelled] ${failure.payload.reason}\n`);
      } else if (failure?.payload.type === "turn/exhausted") {
        options.io.writeError("[exhausted] TurnLimits reached\n");
      }
      options.io.writeError(
        `[turn ${result.status}; tools=${toolCalls}; errors=${toolErrors}; reasoningChars=${reasoningCharacters}]\n`,
      );
      return result.status === "completed";
    } finally {
      active = false;
    }
  }
}

function parseOptions(
  argv: readonly string[],
  defaults: { readonly sessionId?: string } = {},
): ParsedOptions {
  let workspace: string | undefined;
  let sessionsDirectory: string | undefined;
  let sessionId = defaults.sessionId;
  let createNew = false;
  const prompt: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workspace") {
      workspace = argv[++index];
    } else if (argument === "--sessions-dir") {
      sessionsDirectory = argv[++index];
    } else if (argument === "--session") {
      sessionId = argv[++index];
    } else if (argument === "--new") {
      createNew = true;
    } else if (argument?.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (argument !== undefined) {
      prompt.push(argument);
    }
  }

  if (!workspace) throw new Error("--workspace is required");
  const resolvedWorkspace = resolve(workspace);
  return {
    workspace: resolvedWorkspace,
    sessionsDirectory: resolve(
      sessionsDirectory ?? resolve(resolvedWorkspace, ".nervus/sessions"),
    ),
    ...(sessionId ? { sessionId } : {}),
    createNew,
    prompt: prompt.join(" "),
  };
}

function createEnvironmentModel(
  env: Readonly<Record<string, string | undefined>>,
): ModelAdapter {
  const compatibility = env.OPENAI_COMPATIBILITY;
  if (
    compatibility !== undefined &&
    compatibility !== "openai" &&
    compatibility !== "deepseek"
  ) {
    throw new Error("OPENAI_COMPATIBILITY must be openai or deepseek");
  }
  const instructionRole = env.OPENAI_INSTRUCTION_ROLE;
  if (
    instructionRole !== undefined &&
    instructionRole !== "developer" &&
    instructionRole !== "system"
  ) {
    throw new Error("OPENAI_INSTRUCTION_ROLE must be developer or system");
  }
  return new OpenAICompatibleChatAdapter({
    id: "nervus-cli-model",
    baseUrl: requiredValue(env, "OPENAI_BASE_URL"),
    apiKey: requiredValue(env, "OPENAI_API_KEY"),
    ...(compatibility ? { compatibility } : {}),
    ...(instructionRole ? { instructionRole } : {}),
    ...(compatibility === "deepseek"
      ? {
          extraBody: {
            thinking: { type: "enabled" },
            reasoning_effort: env.DEEPSEEK_REASONING_EFFORT ?? "high",
          },
        }
      : {}),
  });
}

function requiredValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (!value) throw new Error(`Set ${name} before starting chat`);
  return value;
}

function countValues(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function collectUsage(events: Awaited<ReturnType<Session["events"]>>) {
  return events.reduce(
    (usage, event) => {
      if (
        event.payload.type === "model/call-completed" &&
        event.payload.usage
      ) {
        usage.inputTokens += event.payload.usage.inputTokens;
        usage.outputTokens += event.payload.usage.outputTokens;
        usage.totalTokens += event.payload.usage.totalTokens;
      }
      return usage;
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

function contentText(content: readonly { readonly type: string; readonly text?: string }[]) {
  return content.map((block) => block.text ?? `[${block.type}]`).join(" ");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeUsage(io: CliIO): void {
  io.write(
    [
      "Usage:",
      "  nervus chat --workspace <path> [--session <id>] [--new] [prompt]",
      "  nervus sessions list --workspace <path>",
      "  nervus sessions inspect <id> --workspace <path>",
      "  nervus sessions resume <id> --workspace <path> [prompt]",
      "",
    ].join("\n"),
  );
}
