import { describe, expect, it } from "@effect/vitest";

import { shellKeepsSandboxBusy } from "./BoatIdleKeeper.ts";
import { sandboxPower } from "./BoatApi.ts";

describe("sandboxPower", () => {
  it.each([
    [{ state: "archived" }, "stopped"],
    [{ state: "stopped" }, "stopped"],
    [{ state: "provisioning" }, "starting"],
    [{ state: "cloning" }, "starting"],
    [{ state: "ready" }, "running"],
    [{ state: "idle" }, "running"],
    [{ state: "ready", stop: { status: "pending" } }, "stopping"],
    [{ state: "ready", stop: { status: "completed" } }, "running"],
    [{ state: "archiving" }, "stopping"],
    [{ state: "error" }, "failed"],
  ] as const)("%j is %s", (sandbox, power) => {
    expect(sandboxPower({ id: "bx_1", ...sandbox })).toBe(power);
  });
});

describe("shellKeepsSandboxBusy", () => {
  const request = { id: "r", kind: "approval", createdAt: null } as never;
  it.each([
    [{ activityRunStatus: "running" }, true],
    [{ activityRunStatus: "starting" }, true],
    [{ activityRunStatus: "waiting", pendingRuntimeRequest: null }, true],
    [{ activityRunStatus: "waiting", pendingRuntimeRequest: request }, false],
    [{ activityRunStatus: null }, false],
    [{ activityRunStatus: null, pendingBackgroundTasks: [{}] }, true],
  ] as const)("%j keeps it up: %s", (shell, busy) => {
    expect(
      shellKeepsSandboxBusy({
        pendingRuntimeRequest: null,
        pendingBackgroundTasks: [],
        ...shell,
      } as Parameters<typeof shellKeepsSandboxBusy>[0]),
    ).toBe(busy);
  });
});
