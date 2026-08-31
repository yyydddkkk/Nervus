import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

export type ProfileErrorCode =
  | "YAML_SYNTAX"
  | "UNSUPPORTED_YAML"
  | "UNSUPPORTED_VERSION"
  | "SCHEMA"
  | "PATH_ESCAPE"
  | "MISSING_PARENT"
  | "INHERITANCE_CYCLE"
  | "HOST_TYPE"
  | "RUNTIME_REFERENCE"
  | "ENV_REFERENCE"
  | "SECRET_LITERAL"
  | "INVALID_SOURCE";

export class ProfileError extends Error {
  constructor(readonly code: ProfileErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProfileError";
  }
}

export interface HostProfileContract {
  readonly hostType: string;
  readonly runtime: Readonly<Record<string, "string" | "number" | "boolean">>;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly defaults?: Readonly<Record<string, unknown>>;
}

export interface FileProfileSource {
  readonly kind: "file";
  readonly file: string;
  readonly roots?: readonly string[];
}

export interface DataProfileSource {
  readonly kind: "data";
  readonly value: Readonly<Record<string, unknown>>;
  readonly baseDirectory: string;
  readonly label?: string;
  readonly roots?: readonly string[];
}

export type ProfileSource = FileProfileSource | DataProfileSource;
export type ProfileOverlay = ProfileSource | Readonly<Record<string, unknown>>;

export interface ResolveProfileOptions {
  readonly source?: ProfileSource;
  /** M14 call-shape compatibility; the document itself must be v2. */
  readonly file?: string;
  readonly roots?: readonly string[];
  readonly overlays?: readonly ProfileOverlay[];
  readonly cli?: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runtime: Readonly<Record<string, unknown>>;
  readonly contract: HostProfileContract;
  readonly mode?: "validate" | "resolve";
}

export interface ProfileSourceResolution {
  readonly kind: "file" | "data";
  readonly label: string;
  readonly path?: string;
  readonly digest: string;
}

export interface SecretSource {
  readonly path: string;
  readonly env: string;
}

export interface ProfileResolution {
  readonly profileVersion: 2;
  readonly profileId: string;
  readonly sourceKind: "file" | "data";
  readonly baseDirectory: string;
  readonly extendsChain: readonly string[];
  readonly sources: readonly ProfileSourceResolution[];
  readonly overlays: readonly ProfileSourceResolution[];
  readonly cliDigest?: string;
  readonly secretSources: readonly SecretSource[];
  readonly normalized: unknown;
  readonly effective?: unknown;
  readonly resolved: boolean;
  readonly capabilityResolution?: unknown;
}

export interface ResolvedProfile {
  /** Effective private values used for assembly; may contain resolved secrets. */
  readonly assembly: Readonly<Record<string, unknown>>;
  /** Merged private values before reference resolution, for Package Schema checks. */
  readonly references: Readonly<Record<string, unknown>>;
  readonly resolution: ProfileResolution;
}

export function composeProfileResolution(
  profile: ProfileResolution,
  capabilityResolution: unknown,
): ProfileResolution {
  return { ...profile, capabilityResolution };
}

export async function resolveProfile(options: ResolveProfileOptions): Promise<ResolvedProfile> {
  const source = normalizeSource(options);
  const entryBase = source.kind === "file" ? dirname(resolve(source.file)) : resolve(source.baseDirectory);
  const roots = await canonicalRoots(source.roots ?? options.roots ?? [entryBase]);
  const sources: ProfileSourceResolution[] = [];
  const chain: string[] = [];
  const loading = new Set<string>();

  const loadFile = async (requested: string): Promise<Record<string, unknown>> => {
    let file: string;
    try {
      file = await realpath(resolve(requested));
    } catch (error) {
      throw new ProfileError("MISSING_PARENT", `Profile not found: ${requested}`, { cause: error });
    }
    assertInsideRoots(file, roots);
    if (loading.has(file)) throw new ProfileError("INHERITANCE_CYCLE", `Profile inheritance cycle: ${file}`);
    loading.add(file);
    try {
      const text = await readFile(file, "utf8");
      const value = parseYamlRecord(text, file);
      assertVersion(value, file);
      let merged: Record<string, unknown> = {};
      if (typeof value.extends === "string") merged = await loadFile(resolve(dirname(file), value.extends));
      merged = mergePatch(merged, value);
      chain.push(String(value.id));
      sources.push({ kind: "file", label: file, path: file, digest: digest(text) });
      return merged;
    } finally {
      loading.delete(file);
    }
  };

  const loadEntry = async (): Promise<Record<string, unknown>> => {
    if (source.kind === "file") return loadFile(source.file);
    const value = cloneRecord(source.value);
    assertVersion(value, source.label ?? "generated Profile");
    let merged: Record<string, unknown> = {};
    if (typeof value.extends === "string") merged = await loadFile(resolve(entryBase, value.extends));
    merged = mergePatch(merged, value);
    chain.push(String(value.id));
    sources.push({ kind: "data", label: source.label ?? "generated", digest: digest(stable(value)) });
    return merged;
  };

  let merged = mergePatch({}, options.contract.defaults ?? {});
  merged = mergePatch(merged, await loadEntry());
  const overlayResolutions: ProfileSourceResolution[] = [];
  for (const [index, overlay] of (options.overlays ?? []).entries()) {
    const loaded = await loadOverlay(overlay, entryBase, roots, index);
    merged = mergePatch(merged, loaded.value);
    overlayResolutions.push(loaded.resolution);
  }
  if (options.cli) merged = mergePatch(merged, options.cli);

  assertVersion(merged, "composed Profile");
  validateSchema(merged, options.contract.schema, true, false);
  const host = merged.host;
  if (!isRecord(host) || host.type !== options.contract.hostType) {
    throw new ProfileError("HOST_TYPE", `Expected Host type ${options.contract.hostType}`);
  }
  const secrets: SecretSource[] = [];
  enforceSecretReferences(merged, options.contract.schema, [], secrets);
  const normalized = redactReferences(merged);
  const validateOnly = options.mode === "validate";
  const resolved = validateOnly
    ? cloneRecord(merged)
    : resolveReferences(merged, options.env, options.runtime, options.contract.runtime);
  if (!validateOnly) validateSchema(resolved, options.contract.schema, false, true);

  return {
    assembly: deepFreeze(cloneRecord(resolved)),
    references: deepFreeze(cloneRecord(merged)),
    resolution: {
      profileVersion: 2,
      profileId: String(merged.id),
      sourceKind: source.kind,
      baseDirectory: entryBase,
      extendsChain: Object.freeze([...chain]),
      sources: Object.freeze(sources.map((item) => Object.freeze({ ...item }))),
      overlays: Object.freeze(overlayResolutions.map((item) => Object.freeze({ ...item }))),
      ...(options.cli ? { cliDigest: digest(stable(options.cli)) } : {}),
      secretSources: Object.freeze(secrets.map((item) => Object.freeze({ ...item }))),
      normalized,
      ...(!validateOnly
        ? { effective: redactEffective(resolved, merged), resolved: true as const }
        : { resolved: false as const }),
    },
  };
}

export async function validateProfile(
  options: Omit<ResolveProfileOptions, "mode">,
): Promise<ResolvedProfile> {
  return resolveProfile({ ...options, mode: "validate" });
}

export function mergeProfilePatch(
  base: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return mergePatch(base, patch);
}

export function enforceSecretReferences(
  value: unknown,
  schema: unknown,
  path: readonly string[] = [],
  output: SecretSource[] = [],
): readonly SecretSource[] {
  if (!isRecord(schema)) return output;
  if (schema["x-secret"] === true) {
    if (!isReference(value, "$env")) {
      throw new ProfileError("SECRET_LITERAL", `Secret must use $env: ${path.join(".")}`);
    }
    output.push({ path: path.join("."), env: value.$env });
    return output;
  }
  if (isRecord(value) && isRecord(schema.properties)) {
    for (const [key, child] of Object.entries(value)) {
      enforceSecretReferences(child, schema.properties[key], [...path, key], output);
    }
  }
  if (Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((child, index) => {
      enforceSecretReferences(child, schema.items, [...path, String(index)], output);
    });
  }
  return output;
}

export function resolveProfileReferences(
  value: unknown,
  options: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly runtime: Readonly<Record<string, unknown>>;
    readonly runtimeTypes: Readonly<Record<string, "string" | "number" | "boolean">>;
  },
): unknown {
  return resolveReferences(value, options.env, options.runtime, options.runtimeTypes);
}

export function redactProfileReferences(value: unknown): unknown {
  return redactReferences(value);
}

async function loadOverlay(
  overlay: ProfileOverlay,
  entryBase: string,
  roots: readonly string[],
  index: number,
): Promise<{ value: Record<string, unknown>; resolution: ProfileSourceResolution }> {
  if (!isProfileSource(overlay)) {
    const value = cloneRecord(overlay);
    return { value, resolution: { kind: "data", label: `overlay-${index + 1}`, digest: digest(stable(value)) } };
  }
  if (overlay.kind === "data") {
    const value = cloneRecord(overlay.value);
    if ("extends" in value) throw new ProfileError("INVALID_SOURCE", "Profile overlays may not extend another Profile");
    return {
      value,
      resolution: { kind: "data", label: overlay.label ?? `overlay-${index + 1}`, digest: digest(stable(value)) },
    };
  }
  let file: string;
  try {
    file = await realpath(resolve(entryBase, overlay.file));
  } catch (error) {
    throw new ProfileError("INVALID_SOURCE", `Overlay not found: ${overlay.file}`, { cause: error });
  }
  assertInsideRoots(file, overlay.roots ? await canonicalRoots(overlay.roots) : roots);
  const text = await readFile(file, "utf8");
  const value = parseYamlRecord(text, file);
  if ("extends" in value) throw new ProfileError("INVALID_SOURCE", "Profile overlays may not extend another Profile");
  return { value, resolution: { kind: "file", label: file, path: file, digest: digest(text) } };
}

function normalizeSource(options: ResolveProfileOptions): ProfileSource {
  if (options.source && options.file) throw new ProfileError("INVALID_SOURCE", "Provide source or file, not both");
  if (options.source) return options.source;
  if (options.file) return { kind: "file", file: options.file, ...(options.roots ? { roots: options.roots } : {}) };
  throw new ProfileError("INVALID_SOURCE", "A Profile source is required");
}

async function canonicalRoots(requested: readonly string[]): Promise<readonly string[]> {
  if (requested.length === 0) throw new ProfileError("INVALID_SOURCE", "At least one Profile Root is required");
  try {
    return await Promise.all(requested.map((root) => realpath(resolve(root))));
  } catch (error) {
    throw new ProfileError("INVALID_SOURCE", "A Profile Root does not exist", { cause: error });
  }
}

function assertInsideRoots(file: string, roots: readonly string[]): void {
  if (!roots.some((root) => inside(root, file))) throw new ProfileError("PATH_ESCAPE", `Profile escapes configured Roots: ${file}`);
}

function parseYamlRecord(source: string, label: string): Record<string, unknown> {
  rejectYamlFeatures(source);
  const document = parseDocument(source, { version: "1.2", strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new ProfileError("YAML_SYNTAX", `${label}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isRecord(value)) throw new ProfileError("SCHEMA", `Profile must be a mapping: ${label}`);
  return value;
}

function rejectYamlFeatures(source: string): void {
  if (/(^|\s)[&*][A-Za-z0-9_-]+|(^|\n)\s*<<:|(^|\s)![A-Za-z]/u.test(source)) {
    throw new ProfileError("UNSUPPORTED_YAML", "YAML anchors, aliases, merge keys, and custom tags are forbidden");
  }
}

function assertVersion(value: Readonly<Record<string, unknown>>, label: string): void {
  if (value.profileVersion !== 2) {
    throw new ProfileError("UNSUPPORTED_VERSION", `Profile v2 is required (${label}); migrate profileVersion: ${String(value.profileVersion)}`);
  }
  if (typeof value.id !== "string" || value.id.length === 0) throw new ProfileError("SCHEMA", `Profile id is required: ${label}`);
}

function validateSchema(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  allowReferences: boolean,
  applyDefaults: boolean,
): void {
  const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: applyDefaults });
  const validate = ajv.compile(
    (allowReferences ? referenceAware(schema, true) : schema) as object,
  );
  if (!validate(value)) throw new ProfileError("SCHEMA", ajv.errorsText(validate.errors));
}

function referenceAware(schema: unknown, root = false): unknown {
  if (!isRecord(schema)) return schema;
  const transformed: Record<string, unknown> = { ...schema };
  if (isRecord(schema.properties)) {
    transformed.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, referenceAware(child)]));
  }
  if (isRecord(schema.items)) transformed.items = referenceAware(schema.items);
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[keyword])) transformed[keyword] = schema[keyword].map((child) => referenceAware(child));
  }
  const structuralObject = schema.type === "object" && isRecord(schema.properties);
  if (root || structuralObject) return transformed;
  return { anyOf: [transformed, referenceSchema("$env"), referenceSchema("$runtime")] };
}

function referenceSchema(key: "$env" | "$runtime"): Record<string, unknown> {
  return { type: "object", properties: { [key]: { type: "string", minLength: 1 } }, required: [key], additionalProperties: false };
}

function resolveReferences(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
  runtime: Readonly<Record<string, unknown>>,
  runtimeTypes: Readonly<Record<string, "string" | "number" | "boolean">>,
): any {
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, env, runtime, runtimeTypes));
  if (!isRecord(value)) return value;
  if (isReference(value, "$env")) {
    const resolved = env[value.$env];
    if (resolved === undefined) throw new ProfileError("ENV_REFERENCE", `Missing environment variable: ${value.$env}`);
    return resolved;
  }
  if (isReference(value, "$runtime")) {
    const type = runtimeTypes[value.$runtime];
    const resolved = runtime[value.$runtime];
    if (!type || typeof resolved !== type) throw new ProfileError("RUNTIME_REFERENCE", `Invalid runtime reference: ${value.$runtime}`);
    return resolved;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveReferences(child, env, runtime, runtimeTypes)]));
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

function mergePatch(base: Readonly<Record<string, unknown>>, patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = cloneRecord(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (isRecord(value) && isRecord(result[key])) result[key] = mergePatch(result[key], value);
    else result[key] = structuredClone(value);
  }
  return result;
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, any> {
  return structuredClone(value) as Record<string, any>;
}

function isReference<K extends "$env" | "$runtime">(value: unknown, key: K): value is Record<K, string> {
  return isRecord(value) && typeof value[key] === "string" && Object.keys(value).length === 1;
}

function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
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

function isProfileSource(value: ProfileOverlay): value is ProfileSource {
  return isRecord(value) && (value.kind === "file" || value.kind === "data");
}
