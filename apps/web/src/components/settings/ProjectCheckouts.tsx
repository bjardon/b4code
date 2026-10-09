import type { EnvironmentId } from "@t3tools/contracts";

import { usePrimaryEnvironmentId } from "../../state/environments";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsSection } from "./settingsLayout";

/**
 * A project's checkouts, one block per environment. Each block lists the main
 * checkout first, without a remove button since its worktrees depend on it;
 * the Danger section removes a whole environment's checkouts instead.
 */
export function ProjectCheckouts({
  members,
  canRemove,
  onRemove,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
  canRemove: (member: SidebarProjectGroupMember) => boolean;
  onRemove: (member: SidebarProjectGroupMember) => void;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const byEnvironment = new Map<EnvironmentId, SidebarProjectGroupMember[]>();
  for (const member of members) {
    const checkouts = byEnvironment.get(member.environmentId) ?? [];
    checkouts.push(member);
    byEnvironment.set(member.environmentId, checkouts);
  }
  const environments = [...byEnvironment.values()].toSorted(
    (left, right) =>
      Number(right[0]!.environmentId === primaryEnvironmentId) -
      Number(left[0]!.environmentId === primaryEnvironmentId),
  );

  return (
    <SettingsSection title="Checkouts">
      {environments.map((checkouts) => {
        const main =
          checkouts.find((member) => member.repositoryIdentity?.linkedWorktree !== true) ?? null;
        const ordered = main ? [main, ...checkouts.filter((member) => member !== main)] : checkouts;
        return (
          <div key={checkouts[0]!.environmentId} className="px-3 py-3 sm:px-4">
            <h3 className="text-sm font-medium text-foreground">
              {checkouts[0]!.environmentLabel ?? "Environment"}
            </h3>
            <ul className="mt-1.5 space-y-1">
              {ordered.map((member) => (
                <li key={member.physicalProjectKey} className="flex min-h-7 items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" />
                      }
                    >
                      {member.workspaceRoot}
                    </TooltipTrigger>
                    <TooltipPopup>
                      <p>{member.workspaceRoot}</p>
                    </TooltipPopup>
                  </Tooltip>
                  <DiffFilePathCopyButton filePath={member.workspaceRoot} />
                  {member === main ? null : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!canRemove(member)}
                      onClick={() => onRemove(member)}
                      aria-label={`Remove checkout ${member.workspaceRoot}`}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </SettingsSection>
  );
}
