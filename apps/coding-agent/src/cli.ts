#!/usr/bin/env node

import { createInterface } from "node:readline";

import { runCodingCli, type CodingCliIO } from "./index.js";

const io: CodingCliIO = {
  write(value) {
    process.stdout.write(value);
  },
  writeError(value) {
    process.stderr.write(value);
  },
  onInterrupt(handler) {
    process.on("SIGINT", handler);
    return () => process.off("SIGINT", handler);
  },
};

const readline = process.stdin.isTTY
  ? createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  : undefined;
const approvalAdapter = readline
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

process.exitCode = await runCodingCli(process.argv.slice(2), {
  io,
  ...(approvalAdapter ? { approvalAdapter } : {}),
});
readline?.close();
