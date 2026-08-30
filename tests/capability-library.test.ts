import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CapabilityLibraryError,
  resolveCapabilityLibrary,
} from "../packages/capability-library/src/index.js";

describe("Capability Library", () => {
  it("expands Bundles, orders dependencies, configures Factories, and records Resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "nervus-capabilities-"));
    try {
      await capability(root, "base", {
        schemaVersion: 1,
        id: "demo/base",
        version: "1.0.0",
        kind: "plugin",
        entry: "./index.js",
        provides: [{ kind: "tool", id: "demo/base" }],
        dependencies: [],
      }, `export default (config) => ({ name: "demo/base:" + config.label, apply() {} });`);
      await capability(root, "feature", {
        schemaVersion: 1,
        id: "demo/feature",
        version: "2.0.0",
        kind: "plugin",
        entry: "./index.js",
        configSchema: "./config.schema.json",
        provides: [{ kind: "skill", id: "demo/feature" }],
        dependencies: ["demo/base"],
      }, `export default () => ({ name: "demo/feature", apply() {} });`, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      });
      await capability(root, "bundle", {
        schemaVersion: 1,
        id: "demo/bundle",
        version: "1.0.0",
        kind: "bundle",
        members: ["demo/feature"],
      });

      const result = await resolveCapabilityLibrary({
        roots: [root],
        select: ["demo/bundle"],
        configure: {
          "demo/base": { label: "configured" },
          "demo/feature": { enabled: true },
        },
      });

      expect(result.plugins.map((plugin) =>
        typeof plugin === "object" && plugin && "name" in plugin
          ? plugin.name
          : "",
      )).toEqual(["demo/base:configured", "demo/feature"]);
      expect(result.resolution).toMatchObject({
        selection: ["demo/bundle"],
        expanded: ["demo/base", "demo/feature"],
        loadOrder: ["demo/base", "demo/feature"],
        packages: [
          { id: "demo/base", version: "1.0.0", dependencies: [] },
          { id: "demo/feature", version: "2.0.0", dependencies: ["demo/base"] },
        ],
        bundles: { "demo/bundle": ["demo/feature"] },
      });
      expect(result.resolution.packages.every((item) => item.digest.length === 64)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails before Factory import for duplicate identities and invalid config", async () => {
    const first = await mkdtemp(join(tmpdir(), "nervus-cap-one-"));
    const second = await mkdtemp(join(tmpdir(), "nervus-cap-two-"));
    try {
      const manifest = {
        schemaVersion: 1,
        id: "demo/duplicate",
        version: "1.0.0",
        kind: "plugin",
        entry: "./index.js",
        provides: [],
        dependencies: [],
      } as const;
      await capability(first, "one", manifest, `throw new Error("must not import");`);
      await capability(second, "two", manifest, `throw new Error("must not import");`);
      await expect(
        resolveCapabilityLibrary({ roots: [first, second], select: [manifest.id] }),
      ).rejects.toMatchObject({
        code: "DUPLICATE_PACKAGE_ID",
      } satisfies Partial<CapabilityLibraryError>);
    } finally {
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ]);
    }
  });

  it("reports missing dependencies, cycles, and Package path escape with stable codes", async () => {
    const root = await mkdtemp(join(tmpdir(), "nervus-cap-errors-"));
    try {
      await capability(root, "missing", {
        schemaVersion: 1, id: "demo/missing", version: "1.0.0", kind: "plugin",
        entry: "./index.js", provides: [], dependencies: ["demo/absent"],
      }, `export default () => ({ name: "missing", apply() {} });`);
      await expect(resolveCapabilityLibrary({ roots: [root], select: ["demo/missing"] }))
        .rejects.toMatchObject({ code: "MISSING_DEPENDENCY" });

      await capability(root, "cycle-a", {
        schemaVersion: 1, id: "demo/a", version: "1.0.0", kind: "plugin",
        entry: "./index.js", provides: [], dependencies: ["demo/b"],
      }, `export default () => ({ name: "a", apply() {} });`);
      await capability(root, "cycle-b", {
        schemaVersion: 1, id: "demo/b", version: "1.0.0", kind: "plugin",
        entry: "./index.js", provides: [], dependencies: ["demo/a"],
      }, `export default () => ({ name: "b", apply() {} });`);
      await expect(resolveCapabilityLibrary({ roots: [root], select: ["demo/a"] }))
        .rejects.toMatchObject({ code: "DEPENDENCY_CYCLE" });

      await writeFile(join(root, "outside.js"), `export default () => ({ apply() {} });`, "utf8");
      await capability(root, "escape", {
        schemaVersion: 1, id: "demo/escape", version: "1.0.0", kind: "plugin",
        entry: "../outside.js", provides: [], dependencies: [],
      });
      await expect(resolveCapabilityLibrary({ roots: [root], select: ["demo/escape"] }))
        .rejects.toMatchObject({ code: "PATH_ESCAPE" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function capability(
  root: string,
  directory: string,
  manifest: object,
  entry?: string,
  schema?: object,
): Promise<void> {
  const target = join(root, directory);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "capability.json"), JSON.stringify(manifest), "utf8");
  if (entry) await writeFile(join(target, "index.js"), entry, "utf8");
  if (schema) {
    await writeFile(join(target, "config.schema.json"), JSON.stringify(schema), "utf8");
  }
}
