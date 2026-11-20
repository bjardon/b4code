import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A boat.dev sandbox that runs another environment's server. The server that
 * holds its boat API key powers it on and off for clients and agents.
 */
export const BoatSandboxPower = Schema.Literals([
  "stopped",
  "starting",
  "running",
  "stopping",
  "failed",
]);
export type BoatSandboxPower = typeof BoatSandboxPower.Type;

export const BoatSandboxStatus = Schema.Struct({
  environmentId: EnvironmentId,
  sandboxId: TrimmedNonEmptyString,
  label: Schema.String,
  power: BoatSandboxPower,
  /** True once the sandbox's own server answers, which trails `running` by about a minute. */
  serverAnswering: Schema.Boolean,
  /** When boat stops it on its own, or null with auto-stop off or while stopped. */
  stopsAt: Schema.NullOr(Schema.DateTimeUtc),
  /** boat's reason when `power` is `failed`. */
  error: Schema.NullOr(Schema.String),
});
export type BoatSandboxStatus = typeof BoatSandboxStatus.Type;

export const BoatSandboxListResult = Schema.Struct({
  sandboxes: Schema.Array(BoatSandboxStatus),
});
export type BoatSandboxListResult = typeof BoatSandboxListResult.Type;

export const BoatSandboxTarget = Schema.Struct({ environmentId: EnvironmentId });
export type BoatSandboxTarget = typeof BoatSandboxTarget.Type;

export const BoatSandboxMoveThreadInput = Schema.Struct({
  /** A thread in this environment, with a git checkout. */
  threadId: ThreadId,
  /** The sandbox environment to continue it in. */
  environmentId: EnvironmentId,
});
export type BoatSandboxMoveThreadInput = typeof BoatSandboxMoveThreadInput.Type;

export const BoatSandboxMoveThreadResult = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectId: ProjectId,
  worktreePath: Schema.String,
  branch: Schema.String,
});
export type BoatSandboxMoveThreadResult = typeof BoatSandboxMoveThreadResult.Type;

export const BoatSandboxSetupProjectInput = Schema.Struct({
  /** A project in this environment whose checkout has an `origin` remote. */
  projectId: ProjectId,
  environmentId: EnvironmentId,
});
export type BoatSandboxSetupProjectInput = typeof BoatSandboxSetupProjectInput.Type;

export const BoatSandboxSetupProjectResult = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  /** False when the sandbox already had the project, so nothing was cloned. */
  cloned: Schema.Boolean,
  copiedFiles: Schema.Array(Schema.String),
  /** The setup command that ran, or null when the project has none. */
  setupCommand: Schema.NullOr(Schema.String),
});
export type BoatSandboxSetupProjectResult = typeof BoatSandboxSetupProjectResult.Type;

export class BoatSandboxError extends Schema.TaggedError<BoatSandboxError>()("BoatSandboxError", {
  message: Schema.String,
}) {}

export const BOAT_SANDBOX_WS_METHODS = {
  list: "boatSandboxes.list",
  wake: "boatSandboxes.wake",
  stop: "boatSandboxes.stop",
  moveThread: "boatSandboxes.moveThread",
  setupProject: "boatSandboxes.setupProject",
} as const;

const error = Schema.Union([BoatSandboxError, EnvironmentAuthorizationError]);

/** Joined into `WsRpcGroup`. */
export const BoatSandboxRpcs = [
  Rpc.make(BOAT_SANDBOX_WS_METHODS.list, {
    payload: Schema.Struct({}),
    success: BoatSandboxListResult,
    error,
  }),
  Rpc.make(BOAT_SANDBOX_WS_METHODS.wake, {
    payload: BoatSandboxTarget,
    success: BoatSandboxStatus,
    error,
  }),
  Rpc.make(BOAT_SANDBOX_WS_METHODS.stop, {
    payload: BoatSandboxTarget,
    success: BoatSandboxStatus,
    error,
  }),
  Rpc.make(BOAT_SANDBOX_WS_METHODS.moveThread, {
    payload: BoatSandboxMoveThreadInput,
    success: BoatSandboxMoveThreadResult,
    error,
  }),
  Rpc.make(BOAT_SANDBOX_WS_METHODS.setupProject, {
    payload: BoatSandboxSetupProjectInput,
    success: BoatSandboxSetupProjectResult,
    error,
  }),
] as const;
