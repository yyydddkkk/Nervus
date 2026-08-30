#!/usr/bin/env node

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

process.exitCode = await runCodingCli(process.argv.slice(2), { io });
