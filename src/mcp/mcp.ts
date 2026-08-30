import {
  Client,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import type { Plugin } from "cordis";

import type { ContextBlock } from "../context/context.js";
import type { ContentBlock, JsonValue } from "../domain/content.js";
import type { ToolExecutionResult } from "../tools/tool.js";

export interface McpPluginOptions {
  readonly id: string;
  readonly client?: Client;
  readonly transport?: Transport;
  readonly namespace?: string;
  readonly closeClient?: boolean;
}

export interface McpStdioPluginOptions
  extends Omit<McpPluginOptions, "client" | "transport">,
    StdioServerParameters {}

export interface McpHttpPluginOptions
  extends Omit<McpPluginOptions, "client" | "transport"> {
  readonly url: string | URL;
  readonly bearerToken?: string;
  readonly requestInit?: RequestInit;
}

export function mcpPlugin(options: McpPluginOptions): Plugin.Object<void> {
  return {
    name: `nervus/mcp/${options.id}`,
    inject: ["tools", "skills", "context"],
    async apply(ctx) {
      const client =
        options.client ??
        new Client({ name: `nervus-${options.id}`, version: "0.0.0" });
      if (options.transport) await client.connect(options.transport);
      if (!options.client && !options.transport) {
        throw new Error("MCP Plugin requires a connected Client or Transport");
      }
      const namespace = options.namespace ?? `mcp/${options.id}`;
      const capabilities = client.getServerCapabilities();
      const [{ tools }, { resources }, { prompts }] = await Promise.all([
        capabilities?.tools
          ? client.listTools()
          : Promise.resolve({ tools: [] }),
        capabilities?.resources
          ? client.listResources()
          : Promise.resolve({ resources: [] }),
        capabilities?.prompts
          ? client.listPrompts()
          : Promise.resolve({ prompts: [] }),
      ]);

      for (const tool of tools) {
        const id = capabilityId(namespace, "tool", tool.name);
        ctx.tools.register({
          id,
          description: tool.description ?? tool.title ?? `MCP Tool ${tool.name}`,
          inputSchema: tool.inputSchema as Readonly<Record<string, unknown>>,
          async execute(input, context) {
            const result = await client.callTool(
              { name: tool.name, arguments: asArguments(input) },
              {
                signal: context.signal,
                onprogress(progress) {
                  context.reportProgress([
                    { type: "json", value: toJsonValue(progress) },
                  ]);
                },
                resetTimeoutOnProgress: true,
              },
            );
            return mapToolResult(result);
          },
        });
      }

      for (const resource of resources) {
        const id = capabilityId(namespace, "resource", resource.name);
        ctx.tools.register({
          id,
          description:
            resource.description ??
            resource.title ??
            `Read MCP Resource ${resource.uri}`,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          async execute(_input, context) {
            const result = await client.readResource(
              { uri: resource.uri },
              { signal: context.signal },
            );
            return {
              status: "success",
              content: result.contents.flatMap(mapResourceContent),
            };
          },
        });
      }

      for (const prompt of prompts) {
        const id = capabilityId(namespace, "prompt", prompt.name);
        ctx.tools.register({
          id,
          description:
            prompt.description ?? prompt.title ?? `Fill MCP Prompt ${prompt.name}`,
          inputSchema: promptInputSchema(prompt.arguments ?? []),
          async execute(input, context) {
            const result = await client.getPrompt(
              {
                name: prompt.name,
                arguments: Object.fromEntries(
                  Object.entries(asArguments(input)).map(([key, value]) => [
                    key,
                    String(value),
                  ]),
                ),
              },
              { signal: context.signal },
            );
            return {
              status: "success",
              content: result.messages.flatMap((message) =>
                mapMcpContent(message.content),
              ),
            };
          },
        });
        ctx.skills.register({
          id,
          name: prompt.title ?? prompt.name,
          description:
            prompt.description ?? `Fill the MCP Prompt ${prompt.name}.`,
          instructions: [
            {
              type: "text",
              text: `Use Tool ${id} to fill the MCP Prompt ${prompt.name} when this template is needed.`,
            },
          ],
        });
      }

      ctx.context.register({
        id: `${namespace}/catalog`,
        contribute(): readonly ContextBlock[] {
          const lines = [
            ...resources.map(
              (resource) =>
                `Resource ${resource.name}: ${capabilityId(namespace, "resource", resource.name)} (${resource.uri})`,
            ),
            ...prompts.map(
              (prompt) =>
                `Prompt ${prompt.name}: ${capabilityId(namespace, "prompt", prompt.name)}`,
            ),
          ];
          return lines.length === 0
            ? []
            : [
                {
                  id: `${namespace}/catalog/block`,
                  source: `${namespace}/catalog`,
                  layer: "runtime",
                  order: 0,
                  retention: "optional",
                  content: {
                    type: "instructions",
                    blocks: [{ type: "text", text: lines.join("\n") }],
                  },
                },
              ];
        },
      });

      return async () => {
        if (options.closeClient ?? true) await client.close();
      };
    },
  };
}

export function mcpStdioPlugin(
  options: McpStdioPluginOptions,
): Plugin.Object<void> {
  const { id, namespace, closeClient, ...stdio } = options;
  return mcpPlugin({
    id,
    transport: new StdioClientTransport(stdio),
    ...(namespace ? { namespace } : {}),
    ...(closeClient === undefined ? {} : { closeClient }),
  });
}

export function mcpHttpPlugin(
  options: McpHttpPluginOptions,
): Plugin.Object<void> {
  const authProvider: AuthProvider | undefined = options.bearerToken
    ? { token: async () => options.bearerToken }
    : undefined;
  return mcpPlugin({
    id: options.id,
    transport: new StreamableHTTPClientTransport(new URL(options.url), {
      ...(authProvider ? { authProvider } : {}),
      ...(options.requestInit ? { requestInit: options.requestInit } : {}),
    }),
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.closeClient === undefined
      ? {}
      : { closeClient: options.closeClient }),
  });
}

function capabilityId(
  namespace: string,
  kind: "tool" | "resource" | "prompt",
  name: string,
): string {
  const segment = /^[A-Za-z0-9._-]+$/.test(name)
    ? name
    : `encoded-${Buffer.from(name, "utf8").toString("base64url")}`;
  return `${namespace}/${kind}/${segment}`;
}

function promptInputSchema(
  args: readonly {
    readonly name: string;
    readonly description?: string | undefined;
    readonly required?: boolean | undefined;
  }[],
): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    properties: Object.fromEntries(
      args.map((argument) => [
        argument.name,
        {
          type: "string",
          ...(argument.description
            ? { description: argument.description }
            : {}),
        },
      ]),
    ),
    required: args.filter((argument) => argument.required).map((argument) => argument.name),
    additionalProperties: false,
  };
}

function mapToolResult(result: {
  readonly content?: readonly unknown[] | undefined;
  readonly structuredContent?: unknown | undefined;
  readonly isError?: boolean | undefined;
}): ToolExecutionResult {
  const content = (result.content ?? []).flatMap(mapMcpContent);
  if (result.structuredContent !== undefined) {
    content.push({ type: "json", value: toJsonValue(result.structuredContent) });
  }
  return {
    status: result.isError ? "error" : "success",
    content,
  };
}

function mapMcpContent(value: unknown): ContentBlock[] {
  if (!value || typeof value !== "object") {
    return [{ type: "json", value: toJsonValue(value) }];
  }
  const block = value as Record<string, unknown>;
  if (block.type === "text" && typeof block.text === "string") {
    return [{ type: "text", text: block.text }];
  }
  if (
    (block.type === "image" || block.type === "audio") &&
    typeof block.data === "string" &&
    typeof block.mimeType === "string"
  ) {
    return [
      {
        type: block.type === "image" ? "image" : "resource",
        uri: `data:${block.mimeType};base64,${block.data}`,
        mediaType: block.mimeType,
      },
    ];
  }
  if (block.type === "resource_link" && typeof block.uri === "string") {
    return [
      {
        type: "resource",
        uri: block.uri,
        ...(typeof block.mimeType === "string"
          ? { mediaType: block.mimeType }
          : {}),
      },
    ];
  }
  if (block.type === "resource" && block.resource) {
    return mapResourceContent(block.resource);
  }
  return [{ type: "json", value: toJsonValue(value) }];
}

function mapResourceContent(value: unknown): ContentBlock[] {
  if (!value || typeof value !== "object") {
    return [{ type: "json", value: toJsonValue(value) }];
  }
  const resource = value as Record<string, unknown>;
  if (typeof resource.text === "string") {
    return [{ type: "text", text: resource.text }];
  }
  if (typeof resource.blob === "string" && typeof resource.uri === "string") {
    return [
      {
        type: "resource",
        uri: resource.uri,
        ...(typeof resource.mimeType === "string"
          ? { mediaType: resource.mimeType }
          : {}),
      },
    ];
  }
  return [{ type: "json", value: toJsonValue(value) }];
}

function asArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
