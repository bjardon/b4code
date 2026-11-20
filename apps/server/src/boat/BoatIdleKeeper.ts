import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeBoatApi } from "./BoatApi.ts";
import { readBoatConfig } from "./BoatConfig.ts";

const DEFAULT_IDLE_STOP_MINUTES = 20;
/** The deadline kept ahead of a busy sandbox; boat's trial allows at most 2 hours. */
const BUSY_DEADLINE_SECONDS = 2 * 60 * 60;
const EXTEND_EVERY_MS = 10 * 60_000;

/**
 * Work that should keep the sandbox up. A run waiting on the user does not:
 * someone who walked away should not keep paying for the machine.
 */
export function shellKeepsSandboxBusy(
  shell: Pick<
    OrchestrationV2ThreadShell,
    "activityRunStatus" | "pendingRuntimeRequest" | "pendingBackgroundTasks"
  >,
): boolean {
  switch (shell.activityRunStatus) {
    case "preparing":
    case "starting":
    case "running":
      return true;
    case "waiting":
      if (shell.pendingRuntimeRequest === null) return true;
      break;
    default:
      break;
  }
  return (shell.pendingBackgroundTasks?.length ?? 0) > 0;
}

/**
 * On the sandbox's own server (`self` in `boat.json`), so it still stops when the
 * machine that woke it sleeps: extends boat's deadline while agents work, stops
 * the sandbox after the idle window. A recent `<home>/boat-hold` counts as work.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { baseDir } = yield* ServerConfig.ServerConfig;
    const holdPath = path.join(baseDir, "boat-hold");
    let lastActiveAt = yield* Clock.currentTimeMillis;
    let lastExtendedAt = 0;

    const busy = Effect.gen(function* () {
      const index = yield* threads.listActiveShellIndex();
      for (const entry of index) {
        if (!entry.mayBeLive) continue;
        const shell = yield* threads.getThreadShell(entry.id);
        if (shell !== null && shellKeepsSandboxBusy(shell)) return true;
      }
      return false;
    });

    const heldSince = fileSystem.stat(holdPath).pipe(
      Effect.map((info) =>
        Option.getOrElse(
          Option.map(info.mtime, (date) => date.getTime()),
          () => 0,
        ),
      ),
      Effect.orElseSucceed(() => 0),
    );

    const tick = Effect.gen(function* () {
      const config = yield* readBoatConfig();
      if (Option.isNone(config) || config.value.self === undefined) return;
      const self = config.value.self;
      const api = yield* makeBoatApi(config.value);
      const now = yield* Clock.currentTimeMillis;
      if (yield* busy) {
        lastActiveAt = now;
        if (now - lastExtendedAt >= EXTEND_EVERY_MS) {
          yield* api.extend(self.id, BUSY_DEADLINE_SECONDS);
          lastExtendedAt = now;
        }
        return;
      }
      lastActiveAt = Math.max(lastActiveAt, yield* heldSince);
      const idleMs = (self.idleStopMinutes ?? DEFAULT_IDLE_STOP_MINUTES) * 60_000;
      if (now - lastActiveAt < idleMs) return;
      yield* Effect.logInfo("boat sandbox idle, stopping it", { sandboxId: self.id });
      yield* api.stop(self.id);
      // The stop ends this process; if it does not, wait out another window first.
      lastActiveAt = now;
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("boat idle check failed", cause)),
      Effect.withSpan("BoatIdleKeeper.tick"),
    );

    yield* tick.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);
  }),
);
