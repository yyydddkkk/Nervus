import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assembleHost,
  explainHost,
  recordSessionAssembly,
  type HostAssemblyOptions,
  type HostContract,
  type HostContribution,
} from "@nervus/host";
import type { Plugin } from "cordis";
import { ScriptedModelAdapter } from "nervus";
import { describe, expect, it } from "vitest";

describe("Host Assembly", () => {
  it("assembles a third-party Host through public APIs and owns idempotent disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "nervus-third-party-host-"));
    try {
      const model = new ScriptedModelAdapter({
        id: "fixture/model",
        steps: [[{ type: "text-delta", delta: "ok" }, { type: "response-completed" }]],
      });
      const assembly = await assembleHost(options(root, modelContribution(model)));
      expect(assembly.agent.id).toBe("fixture-agent");
      expect(assembly.agentSpec).toMatchObject({
        id: "fixture-agent",
        model: { adapter: "fixture/model", model: "fixture-name" },
        instructions: [{ type: "text", text: "Fixture instructions" }],
        limits: { maxSteps: 16, maxModelAttempts: 3 },
      });
      expect(assembly.resolution).toMatchObject({
        host: { id: "fixture/host", contributions: [{ id: "fixture/model-contribution" }] },
        profile: { sourceKind: "data", resolved: true },
        state: { journal: "memory" },
      });
      await Promise.all([assembly.dispose(), assembly.dispose()]);
      expect(assembly.kernel.state).toBe("disposed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("explains without mounting contributions and cleans partial assembly failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "nervus-host-cleanup-"));
    let mounted = false;
    let cleaned = false;
    const missingRegistration: Plugin.Object<void> = {
      name: "fixture/missing-registration",
      apply(ctx) {
        mounted = true;
        ctx.effect(() => () => {
          cleaned = true;
        });
      },
    };
    const contribution: HostContribution = {
      id: "fixture/model-contribution",
      version: "1.0.0",
      digest: "a".repeat(64),
      provides: [{ kind: "model", id: "fixture/model" }],
      plugin: missingRegistration,
    };
    try {
      const input = options(root, contribution);
      await expect(explainHost(input)).resolves.toMatchObject({ agent: { id: "fixture-agent" } });
      expect(mounted).toBe(false);
      await expect(assembleHost(input)).rejects.toMatchObject({ code: "INVALID_AGENT_SPEC" });
      expect(mounted).toBe(true);
      expect(cleaned).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists immutable Resolutions and guards attributable Session changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "nervus-host-resolution-"));
    const model = new ScriptedModelAdapter({ id: "fixture/model", steps: [] });
    const assembly = await assembleHost(options(root, modelContribution(model)));
    try {
      const fileResolution = {
        ...assembly.resolution,
        profile: { ...assembly.resolution.profile, sourceKind: "file" as const },
      };
      const first = await recordSessionAssembly({
        stateDirectory: root,
        sessionId: "session-one",
        action: "create",
        resolution: fileResolution,
        profileExplicit: true,
        now: () => "2026-08-31T00:00:00.000Z",
      });
      expect(first.changed).toBe(false);
      const changedResolution = {
        ...fileResolution,
        digest: "b".repeat(64),
      };
      const changed = await recordSessionAssembly({
        stateDirectory: root,
        sessionId: "session-one",
        action: "open",
        resolution: changedResolution,
        profileExplicit: true,
        now: () => "2026-08-31T00:01:00.000Z",
      });
      expect(changed).toMatchObject({ changed: true, previousDigest: fileResolution.digest });
      await expect(recordSessionAssembly({
        stateDirectory: root,
        sessionId: "session-one",
        action: "open",
        resolution: changedResolution,
        profileExplicit: false,
      })).rejects.toMatchObject({ code: "SESSION_PROFILE_MISMATCH" });
      const wrongAgent = {
        ...changedResolution,
        digest: "c".repeat(64),
        agent: { ...(changedResolution.agent as Record<string, unknown>), id: "other-agent" },
      };
      await expect(recordSessionAssembly({
        stateDirectory: root,
        sessionId: "session-one",
        action: "open",
        resolution: wrongAgent,
        profileExplicit: true,
      })).rejects.toMatchObject({ code: "SESSION_PROFILE_MISMATCH" });
      expect(await readdir(join(root, ".host-assembly", "resolutions"))).toHaveLength(2);
      const references = await readFile(
        join(root, ".host-assembly", "sessions", `${Buffer.from("session-one").toString("base64url")}.jsonl`),
        "utf8",
      );
      expect(references.trim().split("\n")).toHaveLength(2);
    } finally {
      await assembly.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function options(root: string, contribution: HostContribution): HostAssemblyOptions {
  return {
    source: {
      kind: "data",
      label: "fixture-profile",
      baseDirectory: root,
      value: {
        profileVersion: 2,
        id: "fixture-profile",
        host: { type: "fixture-host", options: {} },
        capabilities: { roots: [], select: [], configure: {} },
        agent: {
          id: "fixture-agent",
          model: { adapter: "fixture/model", name: "fixture-name" },
          instructions: "Fixture instructions",
        },
        state: { journal: { kind: "memory" } },
      },
    },
    env: {},
    runtime: {},
    contract: contract(),
    contributions: [contribution],
  };
}

function contract(): HostContract {
  return {
    id: "fixture/host",
    version: "1.0.0",
    digest: "f".repeat(64),
    hostType: "fixture-host",
    hostOptionsSchema: { type: "object", additionalProperties: false },
    runtime: {},
  };
}

function modelContribution(model: ScriptedModelAdapter): HostContribution {
  const plugin: Plugin.Object<void> = {
    name: "fixture/model-contribution",
    inject: ["models"],
    apply(ctx) {
      ctx.models.register(model);
    },
  };
  return {
    id: "fixture/model-contribution",
    version: "1.0.0",
    digest: "d".repeat(64),
    provides: [{ kind: "model", id: model.id }],
    plugin,
  };
}
