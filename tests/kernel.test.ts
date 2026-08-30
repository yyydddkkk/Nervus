import type { Context, Plugin } from "cordis";
import { describe, expect, it } from "vitest";

import { createKernel } from "../src/index.js";

describe("Kernel", () => {
  it("boots with every required module", async () => {
    const kernel = await createKernel();

    expect(kernel.state).toBe("ready");
    expect(kernel.context.agents.name).toBe("agents");
    expect(kernel.context.sessions.name).toBe("sessions");
    expect(kernel.context.models.name).toBe("models");
    expect(kernel.context.tools.name).toBe("tools");
    expect(kernel.context.context.name).toBe("context");
    expect(kernel.context.skills.name).toBe("skills");

    await kernel.dispose();
  });

  it("mounts host plugins after required modules are available", async () => {
    let applyCount = 0;
    function apply(ctx: Context): void {
      applyCount += 1;
      expect(ctx.models.name).toBe("models");
      expect(ctx.tools.name).toBe("tools");
    }
    const plugin: Plugin.Object<void> = {
      name: "test/host-plugin",
      inject: ["models", "tools"],
      apply,
    };

    const kernel = await createKernel({ plugins: [plugin] });

    expect(applyCount).toBe(1);
    await kernel.dispose();
  });

  it("disposes once and exposes the terminal state", async () => {
    const kernel = await createKernel();

    const first = kernel.dispose();
    const second = kernel.dispose();

    expect(first).toBe(second);
    await first;
    expect(kernel.state).toBe("disposed");
  });
});
