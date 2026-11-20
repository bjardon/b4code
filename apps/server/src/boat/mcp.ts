import {
  BoatSandboxListResult,
  BoatSandboxMoveThreadResult,
  BoatSandboxSetupProjectResult,
  type BoatSandboxError,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { readBoatConfig } from "./BoatConfig.ts";
import * as BoatSandboxes from "./BoatSandboxes.ts";
import * as BoatWork from "./BoatWork.ts";

const SandboxEnvironmentId = EnvironmentId.annotate({
  description: "The sandbox's environment. Omit when this server powers one sandbox.",
});

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    BoatSandboxes.BoatSandboxes,
    BoatWork.BoatWork,
    ThreadManagement.ThreadManagementService,
  ],
};

const SandboxPowerTool = Tool.make("t3_sandbox_power", {
  ...shared,
  description:
    "Power the boat.dev sandboxes this server runs, such as boatbox. `status` lists them. `wake` resumes one and returns once its server answers, 1-2 min. `stop` ends all work running there. Linked-environment tools aimed at a stopped sandbox wake it on their own.",
  parameters: Schema.Struct({
    action: Schema.Literals(["status", "wake", "stop"]),
    environmentId: Schema.optional(SandboxEnvironmentId),
  }),
  success: BoatSandboxListResult,
})
  .annotate(Tool.Title, "Power a boat sandbox")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const SandboxMoveThreadTool = Tool.make("t3_sandbox_move_thread", {
  ...shared,
  description:
    "Continue THIS thread in a boat sandbox. Copies its branch and uncommitted changes there over SSH (never via origin), runs setup, and starts a thread there that carries this conversation and keeps working. This checkout is left as is. Call last in your turn, then give the user the new thread's id.",
  parameters: Schema.Struct({ environmentId: Schema.optional(SandboxEnvironmentId) }),
  success: BoatSandboxMoveThreadResult,
})
  .annotate(Tool.Title, "Move this thread to a boat sandbox")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const SandboxSetupProjectTool = Tool.make("t3_sandbox_setup_project", {
  ...shared,
  description:
    "Put a project on a boat sandbox: clone it into ~/projects, register it there, copy its ignored env files, and install dependencies on a fresh clone. Omit `projectId` for this thread's project.",
  parameters: Schema.Struct({
    environmentId: Schema.optional(SandboxEnvironmentId),
    projectId: Schema.optional(ProjectId),
  }),
  success: BoatSandboxSetupProjectResult,
})
  .annotate(Tool.Title, "Set up a project on a boat sandbox")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const BoatToolkit = Toolkit.make(
  SandboxPowerTool,
  SandboxMoveThreadTool,
  SandboxSetupProjectTool,
);

const failed = (error: BoatSandboxError) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

const pickSandbox = Effect.fn("BoatMcp.pickSandbox")(function* (
  environmentId: EnvironmentId | undefined,
) {
  if (environmentId !== undefined) return environmentId;
  const { sandboxes } = yield* (yield* BoatSandboxes.BoatSandboxes).list.pipe(
    Effect.mapError(failed),
  );
  const [only, ...rest] = sandboxes;
  if (only === undefined || rest.length > 0)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        only === undefined
          ? "This server powers no boat sandboxes."
          : `Pass environmentId: ${sandboxes.map((sandbox) => `${sandbox.label} (${sandbox.environmentId})`).join(", ")}.`,
    });
  return only.environmentId;
});

const callerThread = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.thread === undefined
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Call this from a thread.",
          }),
        )
      : Effect.succeed(scope.thread.threadId),
  ),
);

export const BoatHandlers = McpToolAccess.toLayer(BoatToolkit, {
  t3_sandbox_power: McpToolAccess.writes(({ action, environmentId }) =>
    Effect.gen(function* () {
      const sandboxes = yield* BoatSandboxes.BoatSandboxes;
      if (action !== "status") {
        const target = yield* pickSandbox(environmentId);
        yield* (action === "wake" ? sandboxes.wake(target) : sandboxes.stop(target)).pipe(
          Effect.mapError(failed),
        );
      }
      return yield* sandboxes.list.pipe(Effect.mapError(failed));
    }),
  ),
  t3_sandbox_move_thread: McpToolAccess.actsAsCaller(({ environmentId }) =>
    Effect.gen(function* () {
      const threadId = yield* callerThread;
      const target = yield* pickSandbox(environmentId);
      return yield* (yield* BoatWork.BoatWork)
        .moveThread({ threadId, environmentId: target }, { fromOwnTurn: true })
        .pipe(Effect.mapError(failed));
    }),
  ),
  t3_sandbox_setup_project: McpToolAccess.writes(({ environmentId, projectId }) =>
    Effect.gen(function* () {
      const target = yield* pickSandbox(environmentId);
      const resolvedProjectId =
        projectId ??
        (yield* Effect.gen(function* () {
          const threadId = yield* callerThread;
          const shell = yield* (yield* ThreadManagement.ThreadManagementService)
            .getThreadShell(threadId)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: cause.message,
                  }),
              ),
            );
          if (shell === null)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Pass projectId.",
            });
          return shell.projectId;
        }));
      return yield* (yield* BoatWork.BoatWork)
        .setupProject({ projectId: resolvedProjectId, environmentId: target })
        .pipe(Effect.mapError(failed));
    }),
  ),
});

/** Lists the tools only where `boat.json` names sandboxes, read once at startup. */
export const whenSandboxesConfigured = <A, E, R>(registration: Layer.Layer<A, E, R>) =>
  Layer.unwrap(
    readBoatConfig().pipe(
      Effect.map((config) =>
        Option.exists(config, (value) => (value.sandboxes?.length ?? 0) > 0)
          ? registration
          : Layer.empty,
      ),
      Effect.orElseSucceed(() => Layer.empty),
    ),
  );
