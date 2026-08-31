import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assembleHost,
  createSupervisedToolAuthorizer,
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
  it("scopes remembered Supervised approvals to one Turn", async () => {
    let approvals = 0;
    const authorizer = createSupervisedToolAuthorizer({
      id: "fixture/supervised",
      revision: 1,
      autoAllowTools: ["fs/read"],
      approval: {
        async request() {
          approvals += 1;
          return "allow-turn";
        },
      },
    });
    const call = {
      id: "write",
      toolId: "fs/write",
      arguments: { path: "value.txt" },
    };
    const context = (turnId: string, signal: AbortSignal) => ({
      sessionId: "session",
      turnId,
      stepId: "step",
      callId: call.id,
      signal,
    });
    const firstTurn = new AbortController().signal;

    await expect(authorizer.authorize(
      call,
      context("turn-one", firstTurn),
    )).resolves.toEqual({ status: "allow" });
    expect(authorizer.authorize(
      { ...call, id: "write-again" },
      context("turn-one", firstTurn),
    )).toEqual({ status: "allow" });
    expect(authorizer.authorize(
      { id: "read", toolId: "fs/read", arguments: {} },
      context("turn-one", firstTurn),
    )).toEqual({ status: "allow" });

    await expect(authorizer.authorize(
      call,
      context("turn-two", new AbortController().signal),
    )).resolves.toEqual({ status: "allow" });
    expect(approvals).toBe(2);
  });

  it("serializes Supervised approval prompts without combining decisions", async () => {
    let active = 0;
    let maximumActive = 0;
    let approvals = 0;
    const authorizer = createSupervisedToolAuthorizer({
      id: "fixture/serialized-supervised",
      revision: 1,
      autoAllowTools: [],
      approval: {
        async request() {
          approvals += 1;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
          return "deny";
        },
      },
    });
    const signal = new AbortController().signal;
    const context = (callId: string) => ({
      sessionId: "session",
      turnId: "turn",
      stepId: "step",
      callId,
      signal,
    });

    const decisions = await Promise.all([
      authorizer.authorize(
        { id: "one", toolId: "fs/write", arguments: {} },
        context("one"),
      ),
      authorizer.authorize(
        { id: "two", toolId: "shell/run", arguments: {} },
        context("two"),
      ),
    ]);

    expect(decisions).toEqual([
      { status: "deny", reason: "Operator denied fs/write" },
      { status: "deny", reason: "Operator denied shell/run" },
    ]);
    expect(approvals).toBe(2);
    expect(maximumActive).toBe(1);
  });

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
