#!/usr/bin/env node

import { createInterface } from "node:readline";

import { runNervusCli, type CliIO } from "./cli/cli.js";

const readline = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: process.stdin.isTTY,
});
const io: CliIO = {
  write(text) {
    process.stdout.write(text);
  },
  writeError(text) {
    process.stderr.write(text);
  },
  readLines() {
    return readline;
  },
  onInterrupt(handler) {
    readline.on("SIGINT", handler);
    return () => readline.off("SIGINT", handler);
  },
  closeInput() {
    readline.close();
  },
};

const approvalAdapter = process.stdin.isTTY
  ? {
      request({ call, context }: {
        readonly call: { readonly toolId: string; readonly arguments: Readonly<Record<string, unknown>> };
        readonly context: { readonly signal: AbortSignal };
      }) {
        return new Promise<"deny" | "allow-once" | "allow-turn">((resolve, reject) => {
          const onAbort = () => reject(context.signal.reason);
          context.signal.addEventListener("abort", onAbort, { once: true });
          readline.question(
            `Approve ${call.toolId} ${JSON.stringify(call.arguments)}? [y]es/[t]urn/[n]o `,
            { signal: context.signal },
            (answer) => {
              context.signal.removeEventListener("abort", onAbort);
              const normalized = answer.trim().toLowerCase();
              resolve(normalized === "t" || normalized === "turn"
                ? "allow-turn"
                : normalized === "y" || normalized === "yes"
                  ? "allow-once"
                  : "deny");
            },
          );
        });
      },
    }
  : undefined;

process.exitCode = await runNervusCli(process.argv.slice(2), {
  io,
  ...(approvalAdapter ? { approvalAdapter } : {}),
});
readline.close();
