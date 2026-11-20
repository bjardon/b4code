import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { BoatSandboxPower as Power, EnvironmentId } from "@t3tools/contracts";
import { PowerIcon, PowerOffIcon } from "lucide-react";
import { useGT } from "gt-react";

import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  boatSandboxEnvironment,
  usePoweredSandbox,
  useSandboxWakes,
  wakeSandbox,
} from "../../state/boatSandboxes";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Power for an environment that runs in a boat.dev sandbox, shown on its row
 * when a connected server powers it. Renders nothing for any other environment.
 */
export function BoatSandboxPowerControl({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const sandbox = usePoweredSandbox(environmentId);
  const waking = useSandboxWakes((state) => state.waking.has(environmentId));
  if (sandbox === null) return null;
  const power: Power | "waking" = waking ? "waking" : sandbox.status.power;
  const label = sandbox.status.label;

  const wake = () => {
    void wakeSandbox(environmentId).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: gt("{label} did not wake", { label }),
        description: error instanceof Error ? error.message : String(error),
      });
    });
  };
  const stop = async () => {
    const result = await runAtomCommand(appAtomRegistry, boatSandboxEnvironment.stop, {
      environmentId: sandbox.controllerEnvironmentId,
      input: { environmentId },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: gt("{label} did not stop", { label }),
        description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
      });
    }
  };

  const text =
    power === "waking" || power === "starting"
      ? gt("Waking…")
      : power === "running"
        ? sandbox.status.serverAnswering
          ? gt("Sandbox on")
          : gt("Sandbox starting…")
        : power === "stopping"
          ? gt("Stopping…")
          : power === "failed"
            ? gt("Sandbox failed")
            : gt("Sandbox off");
  const canWake = power === "stopped" || power === "failed";
  const canStop = power === "running";

  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className="text-muted-foreground text-xs">{text}</span>
      {canWake ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                aria-label={gt("Wake {label}", { label })}
                onClick={wake}
              />
            }
          >
            <PowerIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">{gt("Wake {label}", { label })}</TooltipPopup>
        </Tooltip>
      ) : null}
      {canStop ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost-destructive"
                size="icon-xs"
                aria-label={gt("Stop {label}", { label })}
                onClick={() => void stop()}
              />
            }
          >
            <PowerOffIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {gt("Stop {label}. Work running there ends.", { label })}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
