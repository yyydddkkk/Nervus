import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { Plugin } from "cordis";

import type { JsonValue } from "../domain/content.js";

export interface LocalToolsOptions {
  readonly root: string;
  readonly shell?: string;
  readonly maxOutputBytes?: number;
}

export function localToolsPlugin(options: LocalToolsOptions): Plugin.Object<void> {
  const root = resolve(options.root);
  const shell = options.shell ?? process.env.SHELL ?? "/bin/sh";
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;

  return {
    name: "nervus/local-tools",
    inject: ["tools"],
    apply(ctx) {
      ctx.tools.register({
        id: "fs/read",
        description: "Read one UTF-8 text file inside the configured root.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { path } = input as { path: string };
          const target = resolveInsideRoot(root, path);
          context.reportProgress([
            { type: "text", text: `reading ${path}` },
          ]);
          return {
            status: "success",
            content: [{ type: "text", text: await readFile(target, "utf8") }],
          };
        },
      });

      ctx.tools.register({
        id: "fs/write",
        description: "Write one UTF-8 text file inside the configured root.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { path, content } = input as { path: string; content: string };
          const target = resolveInsideRoot(root, path);
          context.reportProgress([
            { type: "text", text: `writing ${path}` },
          ]);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, "utf8");
          return {
            status: "success",
            content: [
              {
                type: "json",
                value: {
                  path,
                  bytesWritten: Buffer.byteLength(content, "utf8"),
                },
              },
            ],
          };
        },
      });

      ctx.tools.register({
        id: "shell/run",
        description: "Run one shell command inside the configured root.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
            cwd: { type: "string" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { command, cwd = "." } = input as {
            command: string;
            cwd?: string;
          };
          const resolvedCwd = resolveInsideRoot(root, cwd);
          context.reportProgress([
            { type: "text", text: `running shell command in ${cwd}` },
          ]);
          const result = await runShell({
            shell,
            command,
            cwd: resolvedCwd,
            displayCwd: cwd,
            signal: context.signal,
            maxOutputBytes,
          });
          return {
            status: result.exitCode === 0 ? "success" : "error",
            content: [{ type: "json", value: result }],
          };
        },
      });
    },
  };
}

function resolveInsideRoot(root: string, path: string): string {
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) {
    return target;
  }
  throw new Error(`path escapes configured root: ${path}`);
}

interface RunShellOptions {
  readonly shell: string;
  readonly command: string;
  readonly cwd: string;
  readonly displayCwd: string;
  readonly signal: AbortSignal;
  readonly maxOutputBytes: number;
}

interface ShellResult extends Record<string, JsonValue> {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runShell(options: RunShellOptions): Promise<ShellResult> {
  return new Promise<ShellResult>((resolvePromise, reject) => {
    const child = spawn(options.shell, ["-lc", options.command], {
      cwd: options.cwd,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        child.kill();
        rejectOnce(
          new Error(`shell output exceeded ${options.maxOutputBytes} bytes`),
        );
        return;
      }
      target.push(chunk);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", rejectOnce);
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        command: options.command,
        cwd: options.displayCwd,
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
