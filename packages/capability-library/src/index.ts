import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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
        schemaVersion: { const: 1 },
        id: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 },
        kind: { const: "plugin" },
        entry: { type: "string", minLength: 1 },
        configSchema: { type: "string", minLength: 1 },
        artifacts: {
          type: "array",
          items: { type: "string", minLength: 1 },
          uniqueItems: true,
        },
        provides: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", minLength: 1 },
              id: { type: "string", minLength: 1 },
            },
            required: ["kind", "id"],
            additionalProperties: false,
          },
        },
        dependencies: {
          type: "array",
          items: { type: "string", minLength: 1 },
          uniqueItems: true,
        },
      },
      required: ["schemaVersion", "id", "version", "kind", "entry", "provides", "dependencies"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        schemaVersion: { const: 1 },
        id: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 },
        kind: { const: "bundle" },
        members: {
          type: "array",
          items: { type: "string", minLength: 1 },
          uniqueItems: true,
        },
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
  | "HOST_CONTRIBUTION_CONFLICT"
  | "MISSING_DEPENDENCY"
  | "DEPENDENCY_CYCLE"
  | "PATH_ESCAPE"
  | "INVALID_CONFIG"
  | "SECRET_LITERAL"
  | "ENTRY_LOAD_FAILED"
  | "INVALID_FACTORY"
  | "INVALID_PLAN"
  | "CONTENT_CHANGED";

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

export interface CapabilityIdentity {
  readonly kind: string;
  readonly id: string;
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
    readonly provides: readonly CapabilityIdentity[];
    readonly artifacts: readonly string[];
    readonly digest: string;
    readonly config: unknown;
  }[];
}

export interface CapabilityPlan {
  readonly roots: readonly string[];
  readonly resolved: boolean;
  readonly resolution: CapabilityResolution;
}

export interface PlanCapabilityLibraryOptions {
  readonly roots: readonly string[];
  readonly select: readonly string[];
  /** Effective configuration; may contain resolved secrets and is never serialized. */
  readonly configure?: Readonly<Record<string, unknown>>;
  /** Configuration before references resolve, used to enforce x-secret metadata. */
  readonly referenceConfigure?: Readonly<Record<string, unknown>>;
  readonly hostProvides?: readonly CapabilityIdentity[];
  readonly mode?: "validate" | "resolve";
}

export interface ResolveCapabilityLibraryOptions extends PlanCapabilityLibraryOptions {}

interface PluginManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly kind: "plugin";
  readonly entry: string;
  readonly configSchema?: string;
  readonly artifacts?: readonly string[];
  readonly provides: readonly CapabilityIdentity[];
  readonly dependencies: readonly string[];
}

interface BundleManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly kind: "bundle";
  readonly members: readonly string[];
}

type Manifest = PluginManifest | BundleManifest;
interface Indexed {
  readonly manifest: Manifest;
  readonly root: string;
  readonly directory: string;
  readonly source: string;
}

interface InternalPackage {
  readonly manifest: PluginManifest;
  readonly directory: string;
  readonly entry: string;
  readonly contentFiles: readonly string[];
  readonly digest: string;
  readonly config: unknown;
}

interface InternalPlan {
  readonly packages: readonly InternalPackage[];
}

const internals = new WeakMap<CapabilityPlan, InternalPlan>();

export async function planCapabilityLibrary(
  options: PlanCapabilityLibraryOptions,
): Promise<CapabilityPlan> {
  const indexed = new Map<string, Indexed>();
  const provided = new Map<string, string>();
  const roots = await Promise.all(options.roots.map(async (root) => realpath(resolve(root))));
  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, entry.name);
      let source: string;
      try {
        source = await readFile(join(directory, "capability.json"), "utf8");
      } catch {
        continue;
      }
      const manifest = parseManifest(source, directory);
      if (indexed.has(manifest.id)) {
        throw new CapabilityLibraryError("DUPLICATE_PACKAGE_ID", `Duplicate Capability Package ID: ${manifest.id}`);
      }
      if (manifest.kind === "plugin") {
        for (const item of manifest.provides) {
          const key = identityKey(item);
          const previous = provided.get(key);
          if (previous) {
            throw new CapabilityLibraryError("DUPLICATE_PROVIDE", `Duplicate contribution ${key}: ${previous}, ${manifest.id}`);
          }
          provided.set(key, manifest.id);
        }
      }
      indexed.set(manifest.id, { manifest, root, directory, source });
    }
  }

  for (const item of options.hostProvides ?? []) {
    const key = identityKey(item);
    const packageId = provided.get(key);
    if (packageId) {
      throw new CapabilityLibraryError(
        "HOST_CONTRIBUTION_CONFLICT",
        `Host contribution conflicts with ${packageId}: ${key}`,
      );
    }
  }

  const bundles: Record<string, readonly string[]> = {};
  const selected = new Set<string>();
  const expand = (id: string, stack: readonly string[] = []): void => {
    const item = indexed.get(id);
    if (!item) throw new CapabilityLibraryError("MISSING_DEPENDENCY", `Unknown Capability Package: ${id}`);
    if (stack.includes(id)) {
      throw new CapabilityLibraryError("DEPENDENCY_CYCLE", `Capability dependency cycle: ${[...stack, id].join(" -> ")}`);
    }
    if (item.manifest.kind === "bundle") {
      bundles[id] = Object.freeze([...item.manifest.members]);
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
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new CapabilityLibraryError("DEPENDENCY_CYCLE", `Capability dependency cycle at ${id}`);
    visiting.add(id);
    const item = indexed.get(id);
    if (!item || item.manifest.kind !== "plugin") {
      throw new CapabilityLibraryError("MISSING_DEPENDENCY", `Missing executable Package: ${id}`);
    }
    for (const dependency of item.manifest.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };
  for (const id of selected) visit(id);

  const configured = new Set([
    ...Object.keys(options.configure ?? {}),
    ...Object.keys(options.referenceConfigure ?? {}),
  ]);
  for (const id of configured) {
    if (!order.includes(id)) {
      throw new CapabilityLibraryError(
        "INVALID_CONFIG",
        `Configuration supplied for an unselected Package: ${id}`,
      );
    }
  }

  const validateOnly = options.mode === "validate";
  const planned: InternalPackage[] = [];
  const packageResolutions: CapabilityResolution["packages"][number][] = [];
  for (const id of order) {
    const item = indexed.get(id)!;
    const manifest = item.manifest as PluginManifest;
    const referenceConfig = options.referenceConfigure?.[id] ?? options.configure?.[id] ?? {};
    const effectiveConfig = options.configure?.[id] ?? referenceConfig;
    let validatedConfig: unknown = structuredClone(effectiveConfig);
    let schema: unknown;
    let schemaPath: string | undefined;
    if (manifest.configSchema) {
      schemaPath = await confinedPath(item.directory, manifest.configSchema);
      try {
        schema = JSON.parse(await readFile(schemaPath, "utf8"));
      } catch (error) {
        throw new CapabilityLibraryError("INVALID_MANIFEST", `Invalid config Schema for ${id}`, { cause: error });
      }
      enforceSecrets(referenceConfig, schema, ["capabilities", "configure", id]);
      validatedConfig = validateConfig(
        validateOnly ? referenceConfig : effectiveConfig,
        schema,
        validateOnly,
        id,
      );
    }
    const entry = await confinedPath(item.directory, manifest.entry);
    const artifactPaths = await Promise.all((manifest.artifacts ?? []).map((path) => confinedPath(item.directory, path)));
    const contentFiles = unique([join(item.directory, "capability.json"), entry, ...(schemaPath ? [schemaPath] : []), ...artifactPaths]);
    const contentDigest = await digestFiles(item.directory, contentFiles);
    planned.push({ manifest, directory: item.directory, entry, contentFiles, digest: contentDigest, config: validatedConfig });
    packageResolutions.push({
      id,
      version: manifest.version,
      dependencies: Object.freeze([...manifest.dependencies]),
      provides: Object.freeze(manifest.provides.map((provide) => Object.freeze({ ...provide }))),
      artifacts: Object.freeze([...(manifest.artifacts ?? [])]),
      digest: contentDigest,
      config: validateOnly
        ? redactReferences(referenceConfig)
        : redactEffective(validatedConfig, referenceConfig),
    });
  }

  const resolution: CapabilityResolution = deepFreeze({
    selection: [...options.select],
    expanded: [...order],
    loadOrder: [...order],
    bundles,
    packages: packageResolutions,
  });
  const plan: CapabilityPlan = deepFreeze({ roots: [...roots], resolved: !validateOnly, resolution });
  internals.set(plan, { packages: planned });
  return plan;
}

export async function instantiateCapabilityPlan(
  plan: CapabilityPlan,
): Promise<readonly Plugin<void>[]> {
  const internal = internals.get(plan);
  if (!internal || !plan.resolved) {
    throw new CapabilityLibraryError("INVALID_PLAN", "CapabilityPlan is not an executable plan from this process");
  }
  const plugins: Plugin<void>[] = [];
  for (const item of internal.packages) {
    const currentDigest = await digestFiles(item.directory, item.contentFiles);
    if (currentDigest !== item.digest) {
      throw new CapabilityLibraryError("CONTENT_CHANGED", `Capability Package changed after planning: ${item.manifest.id}`);
    }
    let module: { default?: unknown };
    try {
      module = await import(`${pathToFileURL(item.entry).href}?digest=${item.digest}`);
    } catch (error) {
      throw new CapabilityLibraryError("ENTRY_LOAD_FAILED", `Failed to load ${item.manifest.id}`, { cause: error });
    }
    if (typeof module.default !== "function") {
      throw new CapabilityLibraryError("INVALID_FACTORY", `Capability entry has no default Factory: ${item.manifest.id}`);
    }
    const plugin = (module.default as (value: unknown) => Plugin<void>)(item.config);
    if (!plugin || (typeof plugin !== "function" && typeof plugin !== "object")) {
      throw new CapabilityLibraryError("INVALID_FACTORY", `Capability Factory returned an invalid Plugin: ${item.manifest.id}`);
    }
    plugins.push(plugin);
  }
  return Object.freeze(plugins);
}

export async function resolveCapabilityLibrary(
  options: ResolveCapabilityLibraryOptions,
): Promise<{ readonly plugins: readonly Plugin<void>[]; readonly resolution: CapabilityResolution }> {
  const plan = await planCapabilityLibrary(options);
  return { plugins: await instantiateCapabilityPlan(plan), resolution: plan.resolution };
}

function parseManifest(source: string, directory: string): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new CapabilityLibraryError("INVALID_MANIFEST", `Invalid JSON: ${directory}`, { cause: error });
  }
  if (!validateManifest(value)) {
    throw new CapabilityLibraryError(
      "INVALID_MANIFEST",
      `Invalid manifest: ${directory}: ${manifestAjv.errorsText(validateManifest.errors)}`,
    );
  }
  return value as Manifest;
}

function validateConfig(value: unknown, schema: unknown, references: boolean, id: string): unknown {
  const candidate = structuredClone(value);
  const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: !references });
  const validate = ajv.compile((references ? referenceAware(schema, true) : schema) as object);
  if (!validate(candidate)) {
    throw new CapabilityLibraryError("INVALID_CONFIG", `Invalid config for ${id}: ${ajv.errorsText(validate.errors)}`);
  }
  return candidate;
}

function enforceSecrets(value: unknown, schema: unknown, path: readonly string[]): void {
  if (!isRecord(schema)) return;
  if (schema["x-secret"] === true) {
    if (!isReference(value, "$env")) {
      throw new CapabilityLibraryError("SECRET_LITERAL", `Secret must use $env: ${path.join(".")}`);
    }
    return;
  }
  if (isRecord(value) && isRecord(schema.properties)) {
    for (const [key, child] of Object.entries(value)) enforceSecrets(child, schema.properties[key], [...path, key]);
  }
  if (isRecord(value) && isRecord(schema.additionalProperties)) {
    for (const [key, child] of Object.entries(value)) {
      if (!isRecord(schema.properties) || !(key in schema.properties)) {
        enforceSecrets(child, schema.additionalProperties, [...path, key]);
      }
    }
  }
}

function referenceAware(schema: unknown, root = false): unknown {
  if (!isRecord(schema)) return schema;
  const transformed: Record<string, unknown> = { ...schema };
  if (isRecord(schema.properties)) {
    transformed.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, referenceAware(child)]));
  }
  if (isRecord(schema.additionalProperties)) transformed.additionalProperties = referenceAware(schema.additionalProperties);
  if (isRecord(schema.items)) transformed.items = referenceAware(schema.items);
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[keyword])) transformed[keyword] = schema[keyword].map((child) => referenceAware(child));
  }
  const structuralObject = schema.type === "object" && (isRecord(schema.properties) || isRecord(schema.additionalProperties));
  if (root || structuralObject) return transformed;
  return { anyOf: [transformed, refSchema("$env"), refSchema("$runtime")] };
}

function refSchema(key: "$env" | "$runtime"): Record<string, unknown> {
  return { type: "object", properties: { [key]: { type: "string", minLength: 1 } }, required: [key], additionalProperties: false };
}

async function confinedPath(root: string, path: string): Promise<string> {
  let target: string;
  try {
    target = await realpath(resolve(root, path));
  } catch (error) {
    throw new CapabilityLibraryError("PATH_ESCAPE", `Capability path does not exist: ${path}`, { cause: error });
  }
  const pathFromRoot = relative(root, target);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new CapabilityLibraryError("PATH_ESCAPE", `Capability path escapes Package Root: ${path}`);
  }
  return target;
}

async function digestFiles(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    const path = relative(root, file).replaceAll("\\", "/");
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function identityKey(value: CapabilityIdentity): string {
  return `${value.kind}:${value.id}`;
}

function redactReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactReferences);
  if (!isRecord(value)) return value;
  if (isReference(value, "$env")) return { $env: value.$env, redacted: true };
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactReferences(child)]));
}

function redactEffective(value: unknown, references: unknown): unknown {
  if (isReference(references, "$env")) {
    return { $env: references.$env, redacted: true };
  }
  if (Array.isArray(value) && Array.isArray(references)) {
    return value.map((child, index) => redactEffective(child, references[index]));
  }
  if (isRecord(value) && isRecord(references)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        redactEffective(child, references[key]),
      ]),
    );
  }
  return structuredClone(value);
}

function isReference<K extends "$env" | "$runtime">(value: unknown, key: K): value is Record<K, string> {
  return isRecord(value) && typeof value[key] === "string" && Object.keys(value).length === 1;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
