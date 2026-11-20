import { BoatSandboxError, EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

/** A sandbox this server powers for clients and agents, and the environment it runs. */
export const BoatManagedSandbox = Schema.Struct({
  id: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  /** The sandbox server's base URL, polled after a resume until it answers. */
  url: TrimmedNonEmptyString,
  /** `user@host` for moving work there over SSH (Tailscale SSH on boatbox). */
  ssh: Schema.optional(TrimmedNonEmptyString),
  /** Where its server keeps worktrees. Defaults to `~/.b4-code/worktrees`. */
  worktreesDir: Schema.optional(TrimmedNonEmptyString),
});
export type BoatManagedSandbox = typeof BoatManagedSandbox.Type;

/** Set on the sandbox's own server, which stops the sandbox once it idles. */
export const BoatSelfSandbox = Schema.Struct({
  id: TrimmedNonEmptyString,
  idleStopMinutes: Schema.optional(Schema.Number),
});
export type BoatSelfSandbox = typeof BoatSelfSandbox.Type;

export const BoatConfigFile = Schema.Struct({
  apiKey: TrimmedNonEmptyString,
  apiUrl: Schema.optional(TrimmedNonEmptyString),
  sandboxes: Schema.optional(Schema.Array(BoatManagedSandbox)),
  self: Schema.optional(BoatSelfSandbox),
});
export type BoatConfigFile = typeof BoatConfigFile.Type;

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(BoatConfigFile));

/** Re-read on each use, so `boat configure` applies without a restart. None when absent. */
export const readBoatConfig = Effect.fn("BoatConfig.read")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  // Beside `userdata`, written by `node fork/b4.ts boat configure`.
  const path = (yield* Path.Path).join(baseDir, "boat.json");
  const text = yield* fileSystem.readFileString(path).pipe(Effect.option);
  if (Option.isNone(text)) return Option.none<BoatConfigFile>();
  return Option.some(
    yield* decodeConfig(text.value).pipe(
      Effect.mapError(
        (cause) => new BoatSandboxError({ message: `${path} is not valid: ${cause.message}` }),
      ),
    ),
  );
});
