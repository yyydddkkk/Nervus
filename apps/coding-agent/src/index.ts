import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  createKernel,
  JsonlSessionJournal,
  localToolsPlugin,
  OpenAICompatibleChatAdapter,
  type ContextContributor,
  type ContentBlock,
  type KernelOptions,
  type ModelAdapter,
  type Session,
  type SessionEventEnvelope,
} from "nervus";

export interface CodingCliIO {
  write(value: string): void;
  writeError(value: string): void;
  onInterrupt(handler: () => void): () => void;
}

export interface RunCodingCliOptions {
  readonly io: CodingCliIO;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly modelAdapter?: ModelAdapter;
}

export interface CodingRunRecord {
  readonly schemaVersion: 1;
  readonly workspace: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly status: "completed" | "exhausted" | "cancelled" | "failed";
  readonly output: readonly ContentBlock[];
  readonly eventCount: number;
  readonly toolCallCount: number;
  readonly toolErrorCount: number;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
}

interface ParsedInvocation {
  readonly mode: "run" | "resume";
  readonly workspace: string;
  readonly stateDirectory?: string;
  readonly sessionId: string;
  readonly input: string;
  readonly json: boolean;
}

const CODING_SKILL_ID = "nervus/coding";

export async function runCodingCli(
  argv: readonly string[],
  options: RunCodingCliOptions,
): Promise<number> {
  try {
    const [command, ...arguments_] = argv[0] === "--" ? argv.slice(1) : argv;
    if (command === "run") {
      return await runInput(await parseInvocation("run", arguments_), options);
    }
    if (command === "resume") {
      const sessionId = arguments_[0];
      if (!sessionId) throw new Error("resume requires a Session ID");
      return await runInput(
        await parseInvocation("resume", arguments_.slice(1), sessionId),
        options,
      );
    }
    writeUsage(options.io);
    return command ? 1 : 0;
  } catch (error) {
    options.io.writeError(`${formatError(error)}\n`);
    return 1;
  }
}

async function runInput(
  parsed: ParsedInvocation,
  options: RunCodingCliOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const stateDirectory =
    parsed.stateDirectory ?? defaultStateDirectory(parsed.workspace, env);
  await ensureStateWorkspace(stateDirectory, parsed.workspace);
  const model = options.modelAdapter ?? createEnvironmentModel(env);
  const modelName = options.modelAdapter
    ? env.OPENAI_MODEL ?? "scripted"
    : requiredValue(env, "OPENAI_MODEL");
  const rootInstructions = await readOptionalFile(
    resolve(parsed.workspace, "AGENTS.md"),
  );
  const contributor: ContextContributor = {
    id: "nervus/coding-host/root-agents",
    contribute() {
      return rootInstructions === undefined
        ? []
        : [
            {
              id: "host/root-agents",
              source: "nervus/coding-host/root-agents",
              layer: "agent",
              order: 10,
              retention: "required",
              content: {
                type: "instructions",
                blocks: [{ type: "text", text: rootInstructions }],
              },
            },
          ];
    },
  };
  const modelPlugin = {
    name: "nervus/coding-host/model",
    inject: ["models"],
    apply(ctx) {
      ctx.models.register(model);
    },
  } satisfies NonNullable<KernelOptions["plugins"]>[number];
  const codingPlugin = {
    name: "nervus/coding-host/behavior",
    inject: ["skills", "context"],
    apply(ctx) {
      ctx.skills.register({
        id: CODING_SKILL_ID,
        name: "Repository coding",
        description: "Inspect, edit, verify, and review repository changes.",
        instructions: [
          {
            type: "text",
            text: [
              "For every coding task, inspect repository evidence before editing.",
              "Before modifying a nested file, read every nearer AGENTS.md that governs it.",
              "Keep changes within the requested scope.",
              "Run appropriate verification based on repository evidence and instructions.",
              "Before finishing, inspect git status and the final diff.",
              "Report changed behavior, verification, and failures honestly.",
            ].join(" "),
          },
        ],
      });
      ctx.context.register(contributor);
    },
  } satisfies NonNullable<KernelOptions["plugins"]>[number];
  const journal = new JsonlSessionJournal({
    directory: stateDirectory,
  });
  const kernel = await createKernel({
    journal,
    plugins: [
      modelPlugin,
      codingPlugin,
      localToolsPlugin({ root: parsed.workspace }),
    ],
  });
  let session: Session | undefined;
  let active = false;
  const removeText = kernel.context.on("model/text-delta", (update) => {
    if (!parsed.json && update.purpose === "response") {
      options.io.write(update.delta);
    }
  });
  const removeProgress = kernel.context.on("tool/progress", (update) => {
    options.io.writeError(
      `[progress ${update.toolId}] ${contentText(update.content)}\n`,
    );
  });
  const removeInterrupt = options.io.onInterrupt(() => {
    if (active) session?.cancelActiveTurn("Coding Host interrupt");
  });

  try {
    const agent = await kernel.createAgent({
      id: "nervus-coding-agent",
      model: { adapter: model.id, model: modelName, maxOutputTokens: 8_192 },
      instructions: [
        {
          type: "text",
          text: "You are a Coding Agent operating only inside the explicit workspace.",
        },
      ],
      tools: ["fs/read", "fs/list", "fs/write", "shell/run"],
      skills: [{ id: CODING_SKILL_ID, mode: "eager" }],
      limits: {
        maxSteps: 32,
        maxToolCalls: 128,
        maxToolCallsPerStep: 16,
        maxModelAttempts: 48,
      },
      timeouts: { modelMs: 300_000, toolMs: 120_000 },
    });
    session =
      parsed.mode === "resume"
        ? await kernel.openSession({ id: parsed.sessionId })
        : await kernel.createSession({
            id: parsed.sessionId,
            agentId: agent.id,
          });
    options.io.writeError(`[session ${parsed.sessionId}]\n`);
    active = true;
    const before = (await session.events()).length;
    await session.send({
      content: [{ type: "text", text: parsed.input }],
    });
    active = false;
    const events = (await session.events()).slice(before);
    const record = createRunRecord(parsed, events);
    if (parsed.json) {
      options.io.write(`${JSON.stringify(record)}\n`);
    } else {
      options.io.write("\n");
    }
    options.io.writeError(`[turn ${record.status}]\n`);
    return record.status === "completed" ? 0 : 1;
  } finally {
    active = false;
    removeInterrupt();
    removeProgress();
    removeText();
    await kernel.dispose();
  }
}

async function parseInvocation(
  mode: "run" | "resume",
  argv: readonly string[],
  resumedSessionId?: string,
): Promise<ParsedInvocation> {
  let workspace: string | undefined;
  let stateDirectory: string | undefined;
  let sessionId: string | undefined = resumedSessionId;
  let json = false;
  const input: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workspace") {
      workspace = argv[++index];
    } else if (argument === "--state-dir") {
      stateDirectory = argv[++index];
    } else if (argument === "--session") {
      sessionId = argv[++index];
    } else if (argument === "--json") {
      json = true;
    } else if (argument?.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (argument !== undefined) {
      input.push(argument);
    }
  }
  if (!workspace) throw new Error("--workspace is required");
  if (input.length === 0) throw new Error(`${mode} requires a coding task`);
  return {
    mode,
    workspace: await realpath(resolve(workspace)),
    ...(stateDirectory
      ? { stateDirectory: resolve(stateDirectory) }
      : {}),
    sessionId: sessionId ?? createSessionId(),
    input: input.join(" "),
    json,
  };
}

function createRunRecord(
  parsed: ParsedInvocation,
  events: readonly SessionEventEnvelope[],
): CodingRunRecord {
  const started = events.find(
    (event) => event.payload.type === "turn/started",
  );
  if (!started || started.payload.type !== "turn/started") {
    throw new Error("SessionJournal is missing turn/started");
  }
  const turnId = started.payload.turnId;
  const terminal = [...events].reverse().find((event) => {
    const payload = event.payload;
    return (
      "turnId" in payload &&
      payload.turnId === turnId &&
      (payload.type === "turn/completed" ||
        payload.type === "turn/exhausted" ||
        payload.type === "turn/cancelled" ||
        payload.type === "turn/failed")
    );
  });
  if (!terminal) throw new Error("SessionJournal is missing a terminal Turn fact");
  const status = terminalStatus(terminal);
  const output =
    terminal.payload.type === "turn/completed" ? terminal.payload.output : [];
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
  return {
    schemaVersion: 1,
    workspace: parsed.workspace,
    sessionId: parsed.sessionId,
    turnId,
    status,
    output,
    eventCount: events.length,
    toolCallCount: events.filter(
      (event) => event.payload.type === "tool/call-started",
    ).length,
    toolErrorCount: events.filter(
      (event) =>
        (event.payload.type === "tool/call-completed" &&
          event.payload.result.status === "error") ||
        event.payload.type === "tool/call-failed",
    ).length,
    usage,
  };
}

function terminalStatus(
  terminal: SessionEventEnvelope,
): CodingRunRecord["status"] {
  switch (terminal.payload.type) {
    case "turn/completed":
      return "completed";
    case "turn/exhausted":
      return "exhausted";
    case "turn/cancelled":
      return "cancelled";
    case "turn/failed":
      return "failed";
    default:
      throw new Error(`Not a terminal Turn fact: ${terminal.payload.type}`);
  }
}

function defaultStateDirectory(
  workspace: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const stateRoot = env.XDG_STATE_HOME
    ? resolve(env.XDG_STATE_HOME)
    : join(homedir(), ".local", "state");
  const workspaceHash = createHash("sha256")
    .update(workspace)
    .digest("hex")
    .slice(0, 24);
  return join(stateRoot, "nervus", "coding", workspaceHash, "sessions");
}

async function ensureStateWorkspace(
  stateDirectory: string,
  workspace: string,
): Promise<void> {
  await mkdir(stateDirectory, { recursive: true });
  const metadataPath = join(stateDirectory, "workspace.json");
  let stored: unknown;
  try {
    stored = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    try {
      await writeFile(
        metadataPath,
        `${JSON.stringify({ schemaVersion: 1, workspace }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      return;
    } catch (writeError) {
      if (!isNodeError(writeError) || writeError.code !== "EEXIST") {
        throw writeError;
      }
      stored = JSON.parse(await readFile(metadataPath, "utf8"));
    }
  }
  if (
    !stored ||
    typeof stored !== "object" ||
    !("schemaVersion" in stored) ||
    stored.schemaVersion !== 1 ||
    !("workspace" in stored) ||
    stored.workspace !== workspace
  ) {
    throw new Error(
      `state partition belongs to a different workspace: ${stateDirectory}`,
    );
  }
}

function createSessionId(): string {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `code-${timestamp}-${randomBytes(3).toString("hex")}`;
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function createEnvironmentModel(
  env: Readonly<Record<string, string | undefined>>,
): ModelAdapter {
  const compatibility = env.OPENAI_COMPATIBILITY;
  const instructionRole = env.OPENAI_INSTRUCTION_ROLE;
  return new OpenAICompatibleChatAdapter({
    id: "nervus-coding-host-model",
    baseUrl: requiredValue(env, "OPENAI_BASE_URL"),
    apiKey: requiredValue(env, "OPENAI_API_KEY"),
    ...(compatibility === "openai" || compatibility === "deepseek"
      ? { compatibility }
      : {}),
    ...(instructionRole === "developer" || instructionRole === "system"
      ? { instructionRole }
      : {}),
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
  if (!value) throw new Error(`Set ${name} before running nervus-code`);
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contentText(content: readonly ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "json") return JSON.stringify(block.value);
      return block.uri;
    })
    .join(" ");
}

function writeUsage(io: CodingCliIO): void {
  io.write(
    [
      "Usage:",
      "  nervus-code run --workspace <path> [--session <id>] [--state-dir <path>] <task>",
      "  nervus-code resume <session-id> --workspace <path> [--state-dir <path>] <follow-up>",
      "",
    ].join("\n"),
  );
}
