import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ProfileError,
  resolveProfile,
  validateProfile,
} from "../packages/profile/src/index.js";

const contract = {
  hostType: "nervus-code",
  runtime: { workspace: "string" },
  defaults: { settings: { retries: 3 } },
  schema: {
    type: "object",
    properties: {
      profileVersion: { const: 2 },
      id: { type: "string" },
      extends: { type: "string" },
      host: {
        type: "object",
        properties: {
          type: { const: "nervus-code" },
          options: { type: "object", additionalProperties: false },
        },
        required: ["type", "options"],
        additionalProperties: false,
      },
      settings: {
        type: "object",
        properties: {
          name: { type: "string" },
          retries: { type: "integer", default: 5 },
          apiKey: { type: "string", "x-secret": true },
          root: { type: "string" },
          tools: { type: "array", items: { type: "string" } },
        },
        required: ["name", "retries", "apiKey", "root", "tools"],
        additionalProperties: false,
      },
    },
    required: ["profileVersion", "id", "host", "settings"],
    additionalProperties: false,
  },
} as const;

describe("Profile Loader v2", () => {
  it("resolves file inheritance, ordered overlays, defaults, references, and redaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "nervus-profiles-"));
    try {
      await writeFile(join(root, "base.yaml"), `profileVersion: 2
id: base
host:
  type: nervus-code
  options: {}
settings:
  name: base
  apiKey:
    $env: API_KEY
  root:
    $runtime: workspace
  tools: [fs/read]
`, "utf8");
      await writeFile(join(root, "child.yaml"), `profileVersion: 2
id: child
extends: ./base.yaml
host:
  type: nervus-code
  options: {}
settings:
  name: child
  tools: [fs/read, fs/list]
`, "utf8");
      await writeFile(join(root, "overlay.yaml"), `settings:
  name: overlay
`, "utf8");
      const result = await resolveProfile({
        source: { kind: "file", file: join(root, "child.yaml"), roots: [root] },
        overlays: [{ kind: "file", file: "./overlay.yaml" }],
        cli: { settings: { tools: ["fs/list"] } },
        env: { API_KEY: "secret-value" },
        runtime: { workspace: "/tmp/workspace" },
        contract,
      });
      expect(result.assembly).toMatchObject({
        id: "child",
        settings: {
          name: "overlay",
          retries: 3,
          apiKey: "secret-value",
          root: "/tmp/workspace",
          tools: ["fs/list"],
        },
      });
      expect(result.resolution).toMatchObject({
        profileVersion: 2,
        profileId: "child",
        sourceKind: "file",
        extendsChain: ["base", "child"],
        resolved: true,
        secretSources: [{ path: "settings.apiKey", env: "API_KEY" }],
      });
      expect(JSON.stringify(result.resolution)).not.toContain("secret-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts in-memory sources and validates without resolving env/runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "nervus-profile-data-"));
    try {
      const result = await validateProfile({
        source: {
          kind: "data",
          baseDirectory: root,
          label: "generated",
          value: {
            profileVersion: 2,
            id: "generated",
            host: { type: "nervus-code", options: {} },
            settings: {
              name: "demo",
              apiKey: { $env: "MISSING_AT_VALIDATE_TIME" },
              root: { $runtime: "workspace" },
              tools: [],
            },
          },
        },
        env: {},
        runtime: {},
        contract,
      });
      expect(result.resolution).toMatchObject({ sourceKind: "data", resolved: false });
      expect(result.assembly).toMatchObject({
        settings: {
          apiKey: { $env: "MISSING_AT_VALIDATE_TIME" },
          root: { $runtime: "workspace" },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects v1, literal secrets, forbidden YAML, cycles, path escape, and missing values", async () => {
    const root = await mkdtemp(join(tmpdir(), "nervus-profile-errors-"));
    const outside = await mkdtemp(join(tmpdir(), "nervus-profile-outside-"));
    try {
      await writeFile(join(root, "v1.yaml"), "profileVersion: 1\nid: old\n", "utf8");
      await expect(resolveProfile({ file: join(root, "v1.yaml"), roots: [root], env: {}, runtime: {}, contract }))
        .rejects.toMatchObject({ code: "UNSUPPORTED_VERSION" } satisfies Partial<ProfileError>);

      await writeFile(join(root, "anchor.yaml"), `profileVersion: 2
id: bad
host: &host { type: nervus-code, options: {} }
settings: {}
`, "utf8");
      await expect(resolveProfile({ file: join(root, "anchor.yaml"), roots: [root], env: {}, runtime: {}, contract }))
        .rejects.toMatchObject({ code: "UNSUPPORTED_YAML" });

      const validTail = `host: { type: nervus-code, options: {} }
settings:
  name: demo
  apiKey: { $env: API_KEY }
  root: { $runtime: workspace }
  tools: []
`;
      await writeFile(join(root, "a.yaml"), `profileVersion: 2\nid: a\nextends: ./b.yaml\n${validTail}`, "utf8");
      await writeFile(join(root, "b.yaml"), `profileVersion: 2\nid: b\nextends: ./a.yaml\n${validTail}`, "utf8");
      await expect(resolveProfile({ file: join(root, "a.yaml"), roots: [root], env: { API_KEY: "x" }, runtime: { workspace: "/tmp" }, contract }))
        .rejects.toMatchObject({ code: "INHERITANCE_CYCLE" });

      await writeFile(join(outside, "outside.yaml"), `profileVersion: 2\nid: outside\n${validTail}`, "utf8");
      await expect(resolveProfile({ file: join(outside, "outside.yaml"), roots: [root], env: { API_KEY: "x" }, runtime: { workspace: "/tmp" }, contract }))
        .rejects.toMatchObject({ code: "PATH_ESCAPE" });

      await writeFile(join(root, "literal.yaml"), `profileVersion: 2
id: literal
host: { type: nervus-code, options: {} }
settings: { name: demo, apiKey: literal, root: /tmp, tools: [] }
`, "utf8");
      await expect(resolveProfile({ file: join(root, "literal.yaml"), roots: [root], env: {}, runtime: {}, contract }))
        .rejects.toMatchObject({ code: "SECRET_LITERAL" });

      await writeFile(join(root, "missing.yaml"), `profileVersion: 2\nid: missing\n${validTail}`, "utf8");
      await expect(resolveProfile({ file: join(root, "missing.yaml"), roots: [root], env: {}, runtime: { workspace: "/tmp" }, contract }))
        .rejects.toMatchObject({ code: "ENV_REFERENCE" });
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});
