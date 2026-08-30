import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Plugin } from "cordis";
import { describe, expect, it } from "vitest";

import {
  createKernel,
  mcpPlugin,
  type ModelAdapter,
} from "../src/index.js";

describe("MCP Adapter", () => {
  it("maps remote Tools, Resources, and Prompts into Nervus modules", async () => {
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    server.registerTool(
      "echo",
      {
        description: "Echo text from the MCP server.",
        inputSchema: z.object({ text: z.string() }),
      },
      async ({ text }) => ({
        content: [{ type: "text", text: `echo:${text}` }],
      }),
    );
    server.registerResource(
      "about",
      "test://about",
      { description: "About this MCP server.", mimeType: "text/plain" },
      async (uri) => ({
        contents: [{ uri: uri.href, text: "About MCP" }],
      }),
    );
    server.registerPrompt(
      "greet",
      {
        description: "Create a greeting.",
        argsSchema: z.object({ name: z.string() }),
      },
      async ({ name }) => ({
        messages: [
          {
            role: "user",
            content: { type: "text", text: `Hello ${name}` },
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "nervus-test", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const model: ModelAdapter = {
      id: "scripted/mcp",
      async *generate(request) {
        const results = request.messages.filter(
          (message) => message.role === "tool",
        );
        if (results.length === 0) {
          expect(request.tools.map((tool) => tool.id)).toEqual(
            expect.arrayContaining([
              "mcp/demo/tool/echo",
              "mcp/demo/resource/about",
              "mcp/demo/prompt/greet",
            ]),
          );
          expect(
            request.instructions.some(
              (block) =>
                block.type === "text" && block.text.includes("Create a greeting"),
            ),
          ).toBe(true);
          yield {
            type: "tool-call",
            call: {
              id: "mcp-echo",
              toolId: "mcp/demo/tool/echo",
              arguments: { text: "hi" },
            },
          };
          yield {
            type: "tool-call",
            call: {
              id: "mcp-resource",
              toolId: "mcp/demo/resource/about",
              arguments: {},
            },
          };
          yield {
            type: "tool-call",
            call: {
              id: "mcp-prompt",
              toolId: "mcp/demo/prompt/greet",
              arguments: { name: "Ada" },
            },
          };
        } else {
          expect(
            results.map((message) =>
              message.role === "tool"
                ? message.content
                    .filter((block) => block.type === "text")
                    .map((block) => (block.type === "text" ? block.text : ""))
                    .join("\n")
                : "",
            ),
          ).toEqual(["echo:hi", "About MCP", "Hello Ada"]);
          yield { type: "text-delta", delta: "MCP complete" };
        }
        yield { type: "response-completed" };
      },
    };
    const modelPlugin: Plugin.Object<void> = {
      name: "test/mcp-model",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({
      plugins: [
        modelPlugin,
        mcpPlugin({ id: "demo", client, closeClient: true }),
      ],
    });

    try {
      const agent = await kernel.createAgent({
        id: "mcp-agent",
        model: { adapter: model.id, model: "scripted" },
        tools: [
          "mcp/demo/tool/echo",
          "mcp/demo/resource/about",
          "mcp/demo/prompt/greet",
        ],
        skills: [{ id: "mcp/demo/prompt/greet", mode: "available" }],
      });
      const session = await kernel.createSession({
        id: "mcp-session",
        agentId: agent.id,
      });
      await expect(
        session.send({ content: [{ type: "text", text: "Use MCP" }] }),
      ).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "MCP complete" }],
      });
    } finally {
      await kernel.dispose();
      await server.close();
    }
  });
});
