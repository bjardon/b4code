import type { EnvironmentId } from "@t3tools/contracts";
import { PowerIcon } from "lucide-react";
import { msg, useGT } from "gt-react";

import { m } from "../../i18n/messages";
import {
  readPoweredSandbox,
  usePoweredSandbox,
  useSandboxWakes,
  wakeSandbox,
} from "../../state/boatSandboxes";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Replaces the offline banner for a sandbox some connected server powers: it is off, not lost. */
export function useBoatSandboxComposerBanner(
  environmentId: EnvironmentId | null,
): ComposerBannerStackItem | null {
  const gt = useGT();
  const sandbox = usePoweredSandbox(environmentId);
  const waking = useSandboxWakes((state) =>
    environmentId === null ? false : state.waking.has(environmentId),
  );
  if (environmentId === null || sandbox === null) return null;
  const label = sandbox.status.label;
  const starting = waking || sandbox.status.power === "starting";
  return {
    id: `boat-sandbox:${environmentId}`,
    variant: "default",
    group: "environment",
    icon: <PowerIcon />,
    title: starting
      ? gt("Waking {environment}…", { environment: label })
      : gt("{environment} is switched off", { environment: label }),
    description: starting
      ? gt("Messages you send now go out once it's up, in about a minute.")
      : gt("Send a message to wake it, or wake it now."),
    actions: starting ? undefined : (
      <Button size="xs" variant="ghost" onClick={() => void wakeAndReport(environmentId)}>
        {gt("Wake")}
      </Button>
    ),
  };
}

async function wakeAndReport(environmentId: EnvironmentId): Promise<boolean> {
  try {
    await wakeSandbox(environmentId);
    return true;
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(msg("The sandbox did not wake")),
        description: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}

/**
 * A send to a switched-off sandbox wakes it and sends once this client reconnects.
 * Returns false for any other environment, so the caller shows its usual offline notice.
 */
export function wakeSandboxThenSend(environmentId: EnvironmentId, send: () => void): boolean {
  const sandbox = readPoweredSandbox(environmentId);
  if (sandbox === null) return false;
  if (useSandboxWakes.getState().waking.has(environmentId)) {
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: m(msg("Still waking {environment}", { environment: sandbox.status.label })),
        description: m(msg("Your first message sends once it's up.")),
      }),
    );
    return true;
  }
  void wakeAndReport(environmentId).then((woke) => {
    if (woke) send();
  });
  return true;
}
