import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ContextMenuItem,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { boatSandboxEnvironment, poweredSandboxesAtom } from "../state/boatSandboxes";
import { toastManager } from "../components/ui/toast";

const MOVE_PREFIX = "boat-move:";
const SETUP_PREFIX = "boat-setup:";

export type BoatMoveMenuId = `${typeof MOVE_PREFIX}${string}`;
export type BoatSetupMenuId = `${typeof SETUP_PREFIX}${string}`;

/** Sandboxes `environmentId` powers: work moves there through that server. */
function sandboxesPoweredBy(environmentId: EnvironmentId) {
  return [...appAtomRegistry.get(poweredSandboxesAtom).values()].filter(
    (sandbox) => sandbox.controllerEnvironmentId === environmentId,
  );
}

export function boatMoveMenuItems(
  environmentId: EnvironmentId,
): ReadonlyArray<ContextMenuItem<BoatMoveMenuId>> {
  return sandboxesPoweredBy(environmentId).map((sandbox, index) => ({
    id: `${MOVE_PREFIX}${sandbox.status.environmentId}`,
    label: m(msg("Move to {sandbox}", { sandbox: sandbox.status.label })),
    icon: "git-branch",
    ...(index === 0 ? { separatorBefore: true } : {}),
  }));
}

/**
 * "Set up on <sandbox>" for each sandbox a member's server powers that holds no
 * member of this project yet, and the member each one copies from.
 */
export function boatSetupMenu(
  members: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly projectId: ProjectId }>,
) {
  const sources = new Map<EnvironmentId, (typeof members)[number]>();
  const items: Array<ContextMenuItem<BoatSetupMenuId>> = [];
  for (const member of members) {
    for (const sandbox of sandboxesPoweredBy(member.environmentId)) {
      const target = sandbox.status.environmentId;
      if (sources.has(target) || members.some((other) => other.environmentId === target)) continue;
      sources.set(target, member);
      items.push({
        id: `${SETUP_PREFIX}${target}`,
        label: m(msg("Set up on {sandbox}", { sandbox: sandbox.status.label })),
        icon: "folder-plus",
      });
    }
  }
  return {
    items,
    /** Runs a `boat-setup:` pick. Returns false for any other pick. */
    run: (action: string) => {
      const source = action.startsWith(SETUP_PREFIX)
        ? sources.get(action.slice(SETUP_PREFIX.length) as EnvironmentId)
        : undefined;
      return source !== undefined && runBoatSetupAction(action, source);
    },
  };
}

const labelOf = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(poweredSandboxesAtom).get(environmentId)?.status.label ?? environmentId;

function failed(title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) {
  toastManager.add({
    type: "error",
    title,
    description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
  });
}

/**
 * Runs a `boat-move:` menu pick and opens the new thread. Returns false for
 * any other pick. Takes minutes: it may wake the sandbox and install there.
 */
export function runBoatMoveAction(
  action: string,
  thread: ScopedThreadRef,
  open: (ref: { environmentId: EnvironmentId; threadId: ThreadId }) => void,
): boolean {
  if (!action.startsWith(MOVE_PREFIX)) return false;
  const target = action.slice(MOVE_PREFIX.length) as EnvironmentId;
  const label = labelOf(target);
  const progress = toastManager.add({
    type: "loading",
    title: m(msg("Moving to {sandbox}…", { sandbox: label })),
    description: m(
      msg("Copying the branch and changes, then setting up. This can take a few minutes."),
    ),
    timeout: 0,
  });
  void runAtomCommand(appAtomRegistry, boatSandboxEnvironment.moveThread, {
    environmentId: thread.environmentId,
    input: { threadId: thread.threadId, environmentId: target },
  }).then((result) => {
    toastManager.close(progress);
    if (result._tag === "Failure") {
      failed(m(msg("Could not move to {sandbox}", { sandbox: label })), result);
      return;
    }
    toastManager.add({
      type: "success",
      title: m(msg("Moved to {sandbox}", { sandbox: label })),
      description: m(msg("This thread's checkout is unchanged.")),
    });
    open({ environmentId: result.value.environmentId, threadId: result.value.threadId });
  });
  return true;
}

function runBoatSetupAction(
  action: string,
  project: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): boolean {
  if (!action.startsWith(SETUP_PREFIX)) return false;
  const target = action.slice(SETUP_PREFIX.length) as EnvironmentId;
  const label = labelOf(target);
  const progress = toastManager.add({
    type: "loading",
    title: m(msg("Setting up on {sandbox}…", { sandbox: label })),
    timeout: 0,
  });
  void runAtomCommand(appAtomRegistry, boatSandboxEnvironment.setupProject, {
    environmentId: project.environmentId,
    input: { projectId: project.projectId, environmentId: target },
  }).then((result) => {
    toastManager.close(progress);
    if (result._tag === "Failure") {
      failed(m(msg("Could not set up on {sandbox}", { sandbox: label })), result);
      return;
    }
    const { cloned, copiedFiles, setupCommand } = result.value;
    toastManager.add({
      type: "success",
      title: cloned
        ? m(msg("Set up on {sandbox}", { sandbox: label }))
        : m(msg("Already on {sandbox}", { sandbox: label })),
      description: [
        copiedFiles.length > 0
          ? m(msg("Copied {files}.", { files: copiedFiles.join(", ") }))
          : null,
        setupCommand ? m(msg("Ran {command}.", { command: setupCommand })) : null,
      ]
        .filter((line): line is string => line !== null)
        .join(" "),
    });
  });
  return true;
}
