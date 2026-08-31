import { OpenAICompatibleChatAdapter } from "nervus";

export default function openAICompatibleCapability(config) {
  const adapter = new OpenAICompatibleChatAdapter({
    id: "openai-compatible/chat",
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    ...(config.compatibility ? { compatibility: config.compatibility } : {}),
    ...(config.instructionRole ? { instructionRole: config.instructionRole } : {}),
    ...(config.capabilities ? { capabilities: config.capabilities } : {}),
    ...(config.headers ? { headers: config.headers } : {}),
    ...(config.extraBody ? { extraBody: config.extraBody } : {}),
  });
  return {
    name: "nervus/openai-compatible",
    inject: ["models"],
    apply(ctx) {
      ctx.models.register(adapter);
    },
  };
}
