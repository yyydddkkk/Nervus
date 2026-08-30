import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ProfileError,
  resolveProfile,
} from "../packages/profile/src/index.js";

const contract = {
  hostType: "nervus-code",
  runtime: { workspace: "string" },
  schema: {
    type: "object",
    properties: {
      profileVersion: { const: 1 },
      id: { type: "string" },
      extends: { type: "string" },
      host: {
        type: "object",
        properties: {
          type: { const: "nervus-code" },
          options: { type: "object", additionalProperties: true },
        },
        required: ["type"],
        additionalProperties: false,
      },
      capabilities: { type: "object", additionalProperties: true },
      model: {
        type: "object",
        properties: {
          apiKey: { "x-secret": true },
          root: {},
          name: { type: "string" },
        },
        additionalProperties: false,
      },
      agent: { type: "object", additionalProperties: true },
    },
    required: ["profileVersion", "id", "host", "model", "agent"],
    additionalProperties: false,
  },
} as const;

describe("Profile Loader", () => {
  it("resolves one parent, ordered overlays, runtime/env references, and a redacted Resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "nervus-profiles-"));
    try {
      await writeFile(join(root, "base.yaml"), `profileVersion: 1\nid: base\nhost:\n  type: nervus-code\nmodel:\n  name: base-model\n  apiKey:\n    $env: API_KEY\n  root:\n    $runtime: workspace\nagent:\n  tools: [fs/read]\n`, "utf8");
      await writeFile(join(root, "child.yaml"), `profileVersion: 1\nid: child\nextends: ./base.yaml\nhost:\n  type: nervus-code\nmodel:\n  name: child-model\nagent:\n  tools: [fs/read, fs/list]\n`, "utf8");
      const result = await resolveProfile({
        file: join(root, "child.yaml"),
        roots: [root],
        overlays: [{ model: { name: "overlay-model" } }],
        cli: { agent: { tools: ["fs/list"] } },
        env: { API_KEY: "secret-value" },
        runtime: { workspace: "/tmp/workspace" },
        contract,
      });
      expect(result.assembly).toMatchObject({
        id: "child",
        model: {
          name: "overlay-model",
          apiKey: "secret-value",
          root: "/tmp/workspace",
        },
        agent: { tools: ["fs/list"] },
      });
      expect(JSON.stringify(result.resolution)).not.toContain("secret-value");
      expect(result.resolution).toMatchObject({
        profileId: "child",
        extendsChain: ["base", "child"],
        overlayCount: 1,
        secretSources: [{ path: "model.apiKey", env: "API_KEY" }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects secret literals and forbidden YAML before Host effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "nervus-profile-errors-"));
    try {
      await writeFile(join(root, "bad.yaml"), `profileVersion: 1\nid: bad\nhost: &host\n  type: nervus-code\nmodel:\n  apiKey: literal\nagent: {}\n`, "utf8");
      await expect(resolveProfile({ file: join(root, "bad.yaml"), roots: [root], env: {}, runtime: { workspace: "/tmp" }, contract }))
        .rejects.toMatchObject({ code: "UNSUPPORTED_YAML" } satisfies Partial<ProfileError>);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
