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

process.exitCode = await runNervusCli(process.argv.slice(2), { io });
readline.close();
