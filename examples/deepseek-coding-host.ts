import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  collectCodingMetrics,
  runCodingCli,
  type CodingMetrics,
  type CodingCliIO,
  type CodingRunRecord,
} from "../apps/coding-agent/src/index.js";
import {
  JsonlSessionJournal,
  type SessionEventEnvelope,
  type ToolCall,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const runRoot = resolve(".nervus/m11-live");
const apiKey = requiredEnv("OPENAI_API_KEY");

interface CapturedIO extends CodingCliIO {
  readonly output: string[];
  readonly errors: string[];
}

interface TaskReceipt {
  readonly sessionId: string;
  readonly status: CodingRunRecord["status"];
  readonly turnId: string;
  readonly toolCallCount: number;
  readonly toolIds: readonly string[];
  readonly usage: CodingRunRecord["usage"];
  readonly changedFiles: readonly string[];
  readonly verificationPassed: boolean;
  readonly metrics: CodingMetrics;
  readonly scopedInstructionsReadBeforeEdit?: boolean;
}

await rm(runRoot, { recursive: true, force: true });
await mkdir(runRoot, { recursive: true });

const singleFile = await runSingleFileRepair();
const scopedMultiFile = await runScopedMultiFileChange();
const receipt = {
  schemaVersion: 1,
  provider: "DeepSeek through the OpenAI-compatible Adapter",
  model: requiredEnv("OPENAI_MODEL"),
  tasks: { singleFile, scopedMultiFile },
};
const serialized = JSON.stringify(receipt, null, 2);
if (serialized.includes(apiKey)) throw new Error("API key leaked into receipt");
await writeFile(join(runRoot, "receipt.json"), `${serialized}\n`, "utf8");
process.stdout.write(`${serialized}\n`);

async function runSingleFileRepair(): Promise<TaskReceipt> {
  const workspace = join(runRoot, "single-file");
  const stateDirectory = join(runRoot, "state-single");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFiles(workspace, {
    "AGENTS.md": [
      "Inspect files before editing.",
      "Do not modify tests.",
      "Run npm test and inspect git diff plus git status before finishing.",
    ].join("\n"),
    "package.json": JSON.stringify(
      {
        name: "single-file-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    ),
    "src/math.js": "export function add(left, right) {\n  return left - right;\n}\n",
    "test/math.test.js": [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { add } from "../src/math.js";',
      "test(\"adds two numbers\", () => assert.equal(add(2, 3), 5));",
      "",
    ].join("\n"),
  });
  await initializeGit(workspace);
  await expectCommandFailure("npm", ["test"], workspace);

  const { record, events } = await runTask({
    workspace,
    stateDirectory,
    sessionId: "m11-single-file",
    input:
      "Fix the implementation defect so the existing test passes. Do not edit tests. Inspect evidence first, run the repository verification, then inspect the final git diff and status before reporting.",
  });
  await execFileAsync("npm", ["test"], { cwd: workspace });
  const changedFiles = await gitChangedFiles(workspace);
  assertEqual(changedFiles, ["src/math.js"], "single-file changed files");
  const source = await readFile(join(workspace, "src/math.js"), "utf8");
  if (!source.includes("left + right")) {
    throw new Error("single-file repair did not correct addition");
  }
  return taskReceipt(record, events, changedFiles, true);
}

async function runScopedMultiFileChange(): Promise<TaskReceipt> {
  const workspace = join(runRoot, "scoped-multi-file");
  const stateDirectory = join(runRoot, "state-scoped");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFiles(workspace, {
    "AGENTS.md": [
      "Inspect files before editing and do not modify tests.",
      "Before changing nested files, read the nearer AGENTS.md with fs/read.",
      "Run npm test and inspect git diff plus git status before finishing.",
    ].join("\n"),
    "src/AGENTS.md": [
      "All messages returned by files in this directory must be uppercase.",
      "Apply the formatting rule consistently to both greeting.js and farewell.js.",
    ].join("\n"),
    "package.json": JSON.stringify(
      {
        name: "scoped-multi-file-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    ),
    "src/greeting.js":
      'export function greeting(name) {\n  return `Hello, ${name}!`;\n}\n',
    "src/farewell.js":
      'export function farewell(name) {\n  return `Goodbye, ${name}!`;\n}\n',
    "test/messages.test.js": [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { greeting } from "../src/greeting.js";',
      'import { farewell } from "../src/farewell.js";',
      'test("formats both messages", () => {',
      '  assert.equal(greeting("Ada"), "HELLO, ADA!");',
      '  assert.equal(farewell("Ada"), "GOODBYE, ADA!");',
      "});",
      "",
    ].join("\n"),
  });
  await initializeGit(workspace);
  await expectCommandFailure("npm", ["test"], workspace);

  const { record, events } = await runTask({
    workspace,
    stateDirectory,
    sessionId: "m11-scoped-multi-file",
    input:
      "Update the message implementations so all existing tests pass. Do not edit tests. You must use fs/read to read every applicable AGENTS.md before using fs/write on nested files. Run verification and inspect the final git diff and status before reporting.",
  });
  await execFileAsync("npm", ["test"], { cwd: workspace });
  const changedFiles = await gitChangedFiles(workspace);
  assertEqual(
    changedFiles,
    ["src/farewell.js", "src/greeting.js"],
    "scoped changed files",
  );
  const calls = toolCalls(events);
  const instructionRead = calls.findIndex(
    (call) =>
      call.toolId === "fs/read" && call.arguments.path === "src/AGENTS.md",
  );
  const firstNestedWrite = calls.findIndex(
    (call) =>
      call.toolId === "fs/write" &&
      typeof call.arguments.path === "string" &&
      call.arguments.path.startsWith("src/"),
  );
  const scopedInstructionsReadBeforeEdit =
    instructionRead >= 0 &&
    firstNestedWrite >= 0 &&
    instructionRead < firstNestedWrite;
  if (!scopedInstructionsReadBeforeEdit) {
    throw new Error("scoped AGENTS.md was not read before nested edits");
  }
  return taskReceipt(record, events, changedFiles, true, true);
}

async function runTask(options: {
  readonly workspace: string;
  readonly stateDirectory: string;
  readonly sessionId: string;
  readonly input: string;
}): Promise<{
  readonly record: CodingRunRecord;
  readonly events: readonly SessionEventEnvelope[];
}> {
  const io = captureIO();
  const exitCode = await runCodingCli(
    [
      "run",
      "--workspace",
      options.workspace,
      "--state-dir",
      options.stateDirectory,
      "--session",
      options.sessionId,
      "--json",
      options.input,
    ],
    { io },
  );
  if (exitCode !== 0) {
    throw new Error(
      `Coding Host failed for ${options.sessionId}: ${io.errors.join("")}`,
    );
  }
  const output = io.output.join("");
  if (output.includes(apiKey) || io.errors.join("").includes(apiKey)) {
    throw new Error("API key leaked into Host output");
  }
  const record = JSON.parse(output) as CodingRunRecord;
  const journal = new JsonlSessionJournal({
    directory: options.stateDirectory,
  });
  const events = await journal.read(options.sessionId);
  if (JSON.stringify(events).includes(apiKey)) {
    throw new Error("API key leaked into SessionJournal");
  }
  return { record, events };
}

function taskReceipt(
  record: CodingRunRecord,
  events: readonly SessionEventEnvelope[],
  changedFiles: readonly string[],
  verificationPassed: boolean,
  scopedInstructionsReadBeforeEdit?: boolean,
): TaskReceipt {
  const calls = toolCalls(events);
  const metrics = collectCodingMetrics(events);
  return {
    sessionId: record.sessionId,
    status: record.status,
    turnId: record.turnId,
    toolCallCount: calls.length,
    toolIds: calls.map((call) => call.toolId),
    usage: record.usage,
    changedFiles,
    verificationPassed,
    metrics,
    ...(scopedInstructionsReadBeforeEdit === undefined
      ? {}
      : { scopedInstructionsReadBeforeEdit }),
  };
}

function toolCalls(events: readonly SessionEventEnvelope[]): readonly ToolCall[] {
  return events.flatMap((event) =>
    event.payload.type === "tool/call-started" ? [event.payload.call] : [],
  );
}

async function writeFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const target = join(root, path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(
        target,
        `${content}${content.endsWith("\n") ? "" : "\n"}`,
        "utf8",
      );
    }),
  );
}

async function initializeGit(workspace: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Nervus Live Fixture",
      "-c",
      "user.email=fixture@nervus.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: workspace },
  );
}

async function gitChangedFiles(workspace: string): Promise<readonly string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-only", "HEAD"],
    { cwd: workspace },
  );
  return stdout.trim().split("\n").filter(Boolean).sort();
}

async function expectCommandFailure(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  try {
    await execFileAsync(command, [...args], { cwd });
  } catch {
    return;
  }
  throw new Error(`${command} ${args.join(" ")} unexpectedly passed before repair`);
}

function captureIO(): CapturedIO {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    write(value) {
      output.push(value);
    },
    writeError(value) {
      errors.push(value);
    },
    onInterrupt() {
      return () => undefined;
    },
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running live acceptance`);
  return value;
}

function assertEqual(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} mismatch: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
}
