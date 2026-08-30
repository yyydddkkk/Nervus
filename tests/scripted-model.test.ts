import { describe, expect, it } from "vitest";

import {
  ScriptedModelAdapter,
  type ModelRequest,
} from "../src/index.js";

const request: ModelRequest = {
  model: "scripted",
  instructions: [],
  messages: [],
  tools: [],
};

describe("ScriptedModelAdapter", () => {
  it("consumes deterministic event scripts in ModelCall order", async () => {
    const adapter = new ScriptedModelAdapter({
      id: "scripted/public",
      steps: [
        [
          { type: "text-delta", delta: "first" },
          { type: "response-completed" },
        ],
        [
          { type: "text-delta", delta: "second" },
          { type: "response-completed" },
        ],
      ],
    });

    const first = [];
    for await (const event of adapter.generate(request, {
      signal: new AbortController().signal,
    })) {
      first.push(event);
    }
    const second = [];
    for await (const event of adapter.generate(request, {
      signal: new AbortController().signal,
    })) {
      second.push(event);
    }

    expect(first).toEqual([
      { type: "text-delta", delta: "first" },
      { type: "response-completed" },
    ]);
    expect(second).toEqual([
      { type: "text-delta", delta: "second" },
      { type: "response-completed" },
    ]);
    await expect(async () => {
      for await (const _event of adapter.generate(request, {
        signal: new AbortController().signal,
      })) {
        // No third script exists.
      }
    }).rejects.toMatchObject({ code: "INVARIANT_VIOLATION" });
  });
});
