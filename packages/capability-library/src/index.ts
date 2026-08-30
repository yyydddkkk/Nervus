import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import type { Plugin } from "cordis";

const manifestAjv = new Ajv2020({ allErrors: true, strict: false });
const validateManifest = manifestAjv.compile({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  oneOf: [
    {
      type: "object",
      properties: {
        schemaVersion: { const: 1 }, id: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 }, kind: { const: "plugin" },
        entry: { type: "string", minLength: 1 }, configSchema: { type: "string", minLength: 1 },
        provides: { type: "array", items: { type: "object", properties: { kind: { type: "string", minLength: 1 }, id: { type: "string", minLength: 1 } }, required: ["kind", "id"], additionalProperties: false } },
        dependencies: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
      },
      required: ["schemaVersion", "id", "version", "kind", "entry", "provides", "dependencies"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        schemaVersion: { const: 1 }, id: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 }, kind: { const: "bundle" },
        members: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
      },
      required: ["schemaVersion", "id", "version", "kind", "members"],
      additionalProperties: false,
    },
  ],
});

export type CapabilityLibraryErrorCode =
  | "INVALID_MANIFEST"
  | "DUPLICATE_PACKAGE_ID"
  | "DUPLICATE_PROVIDE"
  | "MISSING_DEPENDENCY"
  | "DEPENDENCY_CYCLE"
  | "PATH_ESCAPE"
  | "INVALID_CONFIG"
  | "ENTRY_LOAD_FAILED"
  | "INVALID_FACTORY";

export class CapabilityLibraryError extends Error {
  constructor(
    readonly code: CapabilityLibraryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CapabilityLibraryError";
  }
}

export interface CapabilityResolution {
  readonly selection: readonly string[];
  readonly expanded: readonly string[];
  readonly loadOrder: readonly string[];
  readonly bundles: Readonly<Record<string, readonly string[]>>;
  readonly packages: readonly {
    readonly id: string;
    readonly version: string;
    readonly dependencies: readonly string[];
    readonly digest: string;
  }[];
}

export interface ResolveCapabilityLibraryOptions {
  readonly roots: readonly string[];
  readonly select: readonly string[];
  readonly configure?: Readonly<Record<string, unknown>>;
}

interface PluginManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  kind: "plugin";
  entry: string;
  configSchema?: string;
  provides: { kind: string; id: string }[];
  dependencies: string[];
}

interface BundleManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  kind: "bundle";
  members: string[];
}

type Manifest = PluginManifest | BundleManifest;
interface Indexed { manifest: Manifest; root: string; directory: string; source: string }

export async function resolveCapabilityLibrary(
  options: ResolveCapabilityLibraryOptions,
): Promise<{ readonly plugins: readonly Plugin<void>[]; readonly resolution: CapabilityResolution }> {
  const indexed = new Map<string, Indexed>();
  const provided = new Set<string>();
  for (const requestedRoot of options.roots) {
    const root = await realpath(resolve(requestedRoot));
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, entry.name);
      let source: string;
      try { source = await readFile(join(directory, "capability.json"), "utf8"); }
      catch { continue; }
      const manifest = parseManifest(source, directory);
      if (indexed.has(manifest.id)) {
        throw new CapabilityLibraryError("DUPLICATE_PACKAGE_ID", `Duplicate Capability Package ID: ${manifest.id}`);
      }
      if (manifest.kind === "plugin") {
        for (const item of manifest.provides) {
          const key = `${item.kind}:${item.id}`;
          if (provided.has(key)) throw new CapabilityLibraryError("DUPLICATE_PROVIDE", `Duplicate contribution: ${key}`);
          provided.add(key);
        }
      }
      indexed.set(manifest.id, { manifest, root, directory, source });
    }
  }

  const bundles: Record<string, readonly string[]> = {};
  const selected = new Set<string>();
  const expand = (id: string, stack: string[] = []) => {
    const item = indexed.get(id);
    if (!item) throw new CapabilityLibraryError("MISSING_DEPENDENCY", `Unknown Capability Package: ${id}`);
    if (stack.includes(id)) throw new CapabilityLibraryError("DEPENDENCY_CYCLE", `Capability dependency cycle: ${[...stack, id].join(" -> ")}`);
    if (item.manifest.kind === "bundle") {
      bundles[id] = item.manifest.members;
      for (const member of item.manifest.members) expand(member, [...stack, id]);
      return;
    }
    selected.add(id);
    for (const dependency of item.manifest.dependencies) expand(dependency, [...stack, id]);
  };
  for (const id of options.select) expand(id);

  const order: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new CapabilityLibraryError("DEPENDENCY_CYCLE", `Capability dependency cycle at ${id}`);
    visiting.add(id);
    const item = indexed.get(id);
    if (!item || item.manifest.kind !== "plugin") throw new CapabilityLibraryError("MISSING_DEPENDENCY", `Missing executable Package: ${id}`);
    for (const dep of item.manifest.dependencies) visit(dep);
    visiting.delete(id); visited.add(id); order.push(id);
  };
  for (const id of selected) visit(id);

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const plugins: Plugin<void>[] = [];
  for (const id of order) {
    const item = indexed.get(id)!;
    const manifest = item.manifest as PluginManifest;
    const config = options.configure?.[id] ?? {};
    if (manifest.configSchema) {
      const schemaPath = await confinedPath(item.directory, manifest.configSchema);
      const validate = ajv.compile(JSON.parse(await readFile(schemaPath, "utf8")));
      if (!validate(config)) throw new CapabilityLibraryError("INVALID_CONFIG", `Invalid config for ${id}: ${ajv.errorsText(validate.errors)}`);
    }
    const entry = await confinedPath(item.directory, manifest.entry);
    let module: { default?: unknown };
    try { module = await import(`${pathToFileURL(entry).href}?digest=${digest(item.source)}`); }
    catch (error) { throw new CapabilityLibraryError("ENTRY_LOAD_FAILED", `Failed to load ${id}`, { cause: error }); }
    if (typeof module.default !== "function") throw new CapabilityLibraryError("INVALID_FACTORY", `Capability entry has no default Factory: ${id}`);
    const plugin = (module.default as (value: unknown) => Plugin<void>)(config);
    if (!plugin || (typeof plugin !== "function" && typeof plugin !== "object")) throw new CapabilityLibraryError("INVALID_FACTORY", `Capability Factory returned an invalid Plugin: ${id}`);
    plugins.push(plugin);
  }
  return {
    plugins,
    resolution: {
      selection: [...options.select],
      expanded: [...order],
      loadOrder: [...order],
      bundles,
      packages: order.map((id) => {
        const item = indexed.get(id)!;
        const manifest = item.manifest as PluginManifest;
        return { id, version: manifest.version, dependencies: [...manifest.dependencies], digest: digest(item.source) };
      }),
    },
  };
}

function parseManifest(source: string, directory: string): Manifest {
  let value: unknown;
  try { value = JSON.parse(source); } catch (error) { throw new CapabilityLibraryError("INVALID_MANIFEST", `Invalid JSON: ${directory}`, { cause: error }); }
  if (!validateManifest(value)) throw new CapabilityLibraryError("INVALID_MANIFEST", `Invalid manifest: ${directory}: ${manifestAjv.errorsText(validateManifest.errors)}`);
  const item = value as unknown as Record<string, unknown>;
  if (item.kind === "bundle") {
    return item as unknown as BundleManifest;
  }
  return item as unknown as PluginManifest;
}

async function confinedPath(root: string, path: string): Promise<string> {
  const target = await realpath(resolve(root, path));
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new CapabilityLibraryError("PATH_ESCAPE", `Capability path escapes Package Root: ${path}`);
  return target;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
