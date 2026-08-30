import type { Plugin } from "cordis";

import {
  createKernel,
  OpenAICompatibleChatAdapter,
} from "../src/index.js";

const apiKey = process.env.OPENAI_API_KEY;
const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const modelName = process.env.OPENAI_MODEL;
if (!apiKey || !modelName) {
  throw new Error(
    "Set OPENAI_API_KEY and OPENAI_MODEL before running pnpm smoke:openai",
  );
}

const adapter = new OpenAICompatibleChatAdapter({
  id: "openai-compatible/smoke",
  baseUrl,
  apiKey,
});
const plugin: Plugin.Object<void> = {
  name: "example/openai-compatible",
  inject: ["models"],
  apply(ctx) {
    ctx.models.register(adapter);
  },
};
const kernel = await createKernel({ plugins: [plugin] });

try {
  const agent = await kernel.createAgent({
    id: "smoke-agent",
    model: { adapter: adapter.id, model: modelName },
    instructions: [
      { type: "text", text: "Answer briefly and plainly." },
    ],
  });
  const session = await kernel.createSession({
    id: `smoke-${Date.now()}`,
    agentId: agent.id,
  });
  const text = process.argv.slice(2).join(" ") || "Say hello from Nervus.";
  const result = await session.send({
    content: [{ type: "text", text }],
  });
  process.stdout.write(
    `${result.output
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")}\n`,
  );
} finally {
  await kernel.dispose();
}
