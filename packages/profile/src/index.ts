import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

export type ProfileErrorCode =
  | "YAML_SYNTAX"
  | "UNSUPPORTED_YAML"
  | "SCHEMA"
  | "PATH_ESCAPE"
  | "MISSING_PARENT"
  | "INHERITANCE_CYCLE"
  | "HOST_TYPE"
  | "RUNTIME_REFERENCE"
  | "ENV_REFERENCE"
  | "SECRET_LITERAL";

export class ProfileError extends Error {
  constructor(readonly code: ProfileErrorCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = "ProfileError";
  }
}

export interface HostProfileContract {
  readonly hostType: string;
  readonly runtime: Readonly<Record<string, "string" | "number" | "boolean">>;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface ResolveProfileOptions {
  readonly file: string;
  readonly roots: readonly string[];
  readonly overlays?: readonly Readonly<Record<string, unknown>>[];
  readonly cli?: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runtime: Readonly<Record<string, unknown>>;
  readonly contract: HostProfileContract;
}

export interface ProfileResolution {
  readonly profileId: string;
  readonly extendsChain: readonly string[];
  readonly sources: readonly { readonly path: string; readonly digest: string }[];
  readonly overlayCount: number;
  readonly overlayDigests: readonly string[];
  readonly cliDigest?: string;
  readonly secretSources: readonly { readonly path: string; readonly env: string }[];
  readonly normalized: unknown;
  readonly capabilityResolution?: unknown;
}

export function composeProfileResolution(
  profile: ProfileResolution,
  capabilityResolution: unknown,
): ProfileResolution {
  return { ...profile, capabilityResolution };
}

export async function resolveProfile(options: ResolveProfileOptions): Promise<{
  readonly assembly: Readonly<Record<string, unknown>>;
  readonly resolution: ProfileResolution;
}> {
  const roots = await Promise.all(options.roots.map((root) => realpath(resolve(root))));
  const sources: { path: string; digest: string }[] = [];
  const chain: string[] = [];
  const loading = new Set<string>();
  const load = async (requested: string): Promise<Record<string, unknown>> => {
    let file: string;
    try { file = await realpath(resolve(requested)); }
    catch (error) { throw new ProfileError("MISSING_PARENT", `Profile not found: ${requested}`, { cause: error }); }
    if (!roots.some((root) => inside(root, file))) throw new ProfileError("PATH_ESCAPE", `Profile escapes configured Roots: ${file}`);
    if (loading.has(file)) throw new ProfileError("INHERITANCE_CYCLE", `Profile inheritance cycle: ${file}`);
    loading.add(file);
    const source = await readFile(file, "utf8");
    rejectYamlFeatures(source);
    const document = parseDocument(source, { version: "1.2", strict: true, uniqueKeys: true });
    if (document.errors.length) throw new ProfileError("YAML_SYNTAX", document.errors.map((e) => e.message).join("; "));
    const value = document.toJS({ maxAliasCount: 0 }) as unknown;
    if (!isRecord(value) || value.profileVersion !== 1 || typeof value.id !== "string") throw new ProfileError("SCHEMA", `Invalid Profile header: ${file}`);
    let merged: Record<string, unknown> = {};
    if (typeof value.extends === "string") merged = await load(resolve(dirname(file), value.extends));
    merged = mergePatch(merged, value);
    chain.push(value.id);
    sources.push({ path: file, digest: digest(source) });
    loading.delete(file);
    return merged;
  };

  let merged = await load(options.file);
  for (const overlay of options.overlays ?? []) merged = mergePatch(merged, overlay);
  if (options.cli) merged = mergePatch(merged, options.cli);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(options.contract.schema);
  if (!validate(merged)) throw new ProfileError("SCHEMA", ajv.errorsText(validate.errors));
  const host = merged.host;
  if (!isRecord(host) || host.type !== options.contract.hostType) throw new ProfileError("HOST_TYPE", `Expected Host type ${options.contract.hostType}`);
  const secrets: { path: string; env: string }[] = [];
  enforceSecrets(merged, options.contract.schema, [], secrets);
  const normalized = redactReferences(merged);
  const assembly = resolveReferences(merged, options, [], secrets);
  if (!isRecord(assembly)) throw new ProfileError("SCHEMA", "Resolved Profile must be an object");
  return {
    assembly,
    resolution: {
      profileId: String(merged.id),
      extendsChain: chain,
      sources,
      overlayCount: options.overlays?.length ?? 0,
      overlayDigests: (options.overlays ?? []).map((item) => digest(stable(item))),
      ...(options.cli ? { cliDigest: digest(stable(options.cli)) } : {}),
      secretSources: secrets,
      normalized,
    },
  };
}

function rejectYamlFeatures(source: string): void {
  if (/(^|\s)[&*][A-Za-z0-9_-]+|(^|\n)\s*<<:|(^|\s)![A-Za-z]/u.test(source)) throw new ProfileError("UNSUPPORTED_YAML", "YAML anchors, aliases, merge keys, and custom tags are forbidden");
}

function mergePatch(base: Record<string, unknown>, patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (isRecord(value) && isRecord(result[key])) result[key] = mergePatch(result[key], value);
    else result[key] = value;
  }
  return result;
}

function enforceSecrets(value: unknown, schema: unknown, path: string[], out: { path: string; env: string }[]): void {
  if (!isRecord(schema)) return;
  if (schema["x-secret"] === true) {
    if (!isRecord(value) || typeof value.$env !== "string" || Object.keys(value).length !== 1) throw new ProfileError("SECRET_LITERAL", `Secret must use $env: ${path.join(".")}`);
    out.push({ path: path.join("."), env: value.$env }); return;
  }
  if (isRecord(value) && isRecord(schema.properties)) {
    for (const [key, child] of Object.entries(value)) enforceSecrets(child, schema.properties[key], [...path, key], out);
  }
}

function resolveReferences(value: unknown, options: ResolveProfileOptions, path: string[], secrets: readonly { path: string; env: string }[]): unknown {
  if (Array.isArray(value)) return value.map((item, i) => resolveReferences(item, options, [...path, String(i)], secrets));
  if (!isRecord(value)) return value;
  if (typeof value.$env === "string" && Object.keys(value).length === 1) {
    const resolved = options.env[value.$env];
    if (resolved === undefined) throw new ProfileError("ENV_REFERENCE", `Missing environment variable: ${value.$env}`);
    return resolved;
  }
  if (typeof value.$runtime === "string" && Object.keys(value).length === 1) {
    const type = options.contract.runtime[value.$runtime];
    const resolved = options.runtime[value.$runtime];
    if (!type || typeof resolved !== type) throw new ProfileError("RUNTIME_REFERENCE", `Invalid runtime reference: ${value.$runtime}`);
    return resolved;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveReferences(child, options, [...path, key], secrets)]));
}

function redactReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactReferences);
  if (!isRecord(value)) return value;
  if (typeof value.$env === "string" && Object.keys(value).length === 1) return { $env: value.$env, redacted: true };
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactReferences(child)]));
}
function inside(root: string, file: string): boolean { const rel = relative(root, file); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stable(value: unknown): string { return JSON.stringify(value, Object.keys(value as object).sort()); }
function isRecord(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
