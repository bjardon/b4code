import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  BOAT_SANDBOX_WS_METHODS,
  type BoatSandboxStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react";
import { create } from "zustand";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";

const list = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:boat-sandboxes:list",
  tag: BOAT_SANDBOX_WS_METHODS.list,
  staleTimeMs: 10_000,
  refreshIntervalMs: 30_000,
});

const refreshList = (environmentId: EnvironmentId) =>
  Effect.sync(() => appAtomRegistry.refresh(list({ environmentId, input: {} })));

export const boatSandboxEnvironment = {
  list,
  wake: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:boat-sandboxes:wake",
    tag: BOAT_SANDBOX_WS_METHODS.wake,
    onSuccess: ({ environmentId }) => refreshList(environmentId),
  }),
  stop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:boat-sandboxes:stop",
    tag: BOAT_SANDBOX_WS_METHODS.stop,
    onSuccess: ({ environmentId }) => refreshList(environmentId),
  }),
  moveThread: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:boat-sandboxes:move-thread",
    tag: BOAT_SANDBOX_WS_METHODS.moveThread,
  }),
  setupProject: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:boat-sandboxes:setup-project",
    tag: BOAT_SANDBOX_WS_METHODS.setupProject,
  }),
};

/** A sandbox environment and the connected environment that powers it. */
export interface PoweredSandbox {
  readonly controllerEnvironmentId: EnvironmentId;
  readonly status: BoatSandboxStatus;
}

/**
 * Every sandbox some connected environment powers, keyed by the sandbox's own
 * environment. Only b4-code servers with `boat.json` answer with any.
 */
export const poweredSandboxesAtom = Atom.make((get) => {
  const sandboxes = new Map<EnvironmentId, PoweredSandbox>();
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    if (presentation.connection.phase !== "connected") continue;
    const result = get(list({ environmentId, input: {} }));
    for (const status of AsyncResult.getOrElse(result, () => ({ sandboxes: [] })).sandboxes) {
      sandboxes.set(status.environmentId, { controllerEnvironmentId: environmentId, status });
    }
  }
  return sandboxes as ReadonlyMap<EnvironmentId, PoweredSandbox>;
}).pipe(Atom.withLabel("boat-sandboxes:powered"));

export function usePoweredSandbox(environmentId: EnvironmentId | null): PoweredSandbox | null {
  const sandboxes = useAtomValue(poweredSandboxesAtom);
  return environmentId === null ? null : (sandboxes.get(environmentId) ?? null);
}

export function readPoweredSandbox(environmentId: EnvironmentId): PoweredSandbox | null {
  return appAtomRegistry.get(poweredSandboxesAtom).get(environmentId) ?? null;
}

/** Wakes in flight, by sandbox environment, so every surface shows the same "Waking…". */
export const useSandboxWakes = create<{ readonly waking: ReadonlySet<EnvironmentId> }>(() => ({
  waking: new Set(),
}));

function setWaking(environmentId: EnvironmentId, waking: boolean) {
  useSandboxWakes.setState(({ waking: current }) => {
    const next = new Set(current);
    if (waking) next.add(environmentId);
    else next.delete(environmentId);
    return { waking: next };
  });
}

const RECONNECT_TIMEOUT_MS = 60_000;

/** Resolves once this client holds a live connection to `environmentId`, or rejects after a minute. */
function waitForConnection(environmentId: EnvironmentId): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(retry);
      unsubscribe?.();
      if (error === null) resolve();
      else reject(error);
    };
    const check = () => {
      const phase = appAtomRegistry
        .get(environmentPresentations.presentationsAtom)
        .get(environmentId)?.connection.phase;
      if (phase === "connected") finish(null);
    };
    const kick = () =>
      void runAtomCommand(appAtomRegistry, environmentCatalog.retryNow, environmentId);
    // The supervisor may be in a long backoff from while the sandbox was down.
    const retry = setInterval(kick, 5_000);
    const timer = setTimeout(
      () => finish(new Error(m(msg("The sandbox woke, but this app could not reconnect to it.")))),
      RECONNECT_TIMEOUT_MS,
    );
    unsubscribe = appAtomRegistry.subscribe(environmentPresentations.presentationsAtom, check);
    kick();
    check();
  });
}

const wakesInFlight = new Map<EnvironmentId, Promise<void>>();

/**
 * Wakes a powered sandbox through its controller and waits until this client
 * reconnects to it. Concurrent callers share one wake.
 */
export function wakeSandbox(environmentId: EnvironmentId): Promise<void> {
  const existing = wakesInFlight.get(environmentId);
  if (existing) return existing;
  const sandbox = readPoweredSandbox(environmentId);
  if (sandbox === null) {
    return Promise.reject(new Error(m(msg("No connected server powers this sandbox."))));
  }
  setWaking(environmentId, true);
  const wake = (async () => {
    const result = await runAtomCommand(appAtomRegistry, boatSandboxEnvironment.wake, {
      environmentId: sandbox.controllerEnvironmentId,
      input: { environmentId },
    });
    if (result._tag === "Failure") {
      throw new Error(
        thrownErrorMessage(squashAtomCommandFailure(result), m) ??
          m(msg("The sandbox did not wake.")),
      );
    }
    await waitForConnection(environmentId);
  })().finally(() => {
    wakesInFlight.delete(environmentId);
    setWaking(environmentId, false);
  });
  wakesInFlight.set(environmentId, wake);
  return wake;
}
