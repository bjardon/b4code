import { resolveEnvironmentMachineKind } from "@t3tools/contracts";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/**
 * The "n environments" caption on a Settings > Projects row. Hovering it
 * lists each environment the project is set up on with its main checkout paths,
 * styled like the setting inheritance popover.
 */
export function ProjectEnvironmentsPopover({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const { environments } = useEnvironments();
  const sections = [...new Set(members.map((member) => member.environmentId))].map(
    (environmentId) => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      const checkouts = members.filter((member) => member.environmentId === environmentId);
      const mainCheckouts = checkouts.filter(
        (member) => member.repositoryIdentity?.linkedWorktree !== true,
      );
      return {
        environmentId,
        label: environment?.label ?? "Unavailable environment",
        machine: resolveEnvironmentMachineKind(environment?.serverConfig ?? null),
        // Worktrees stay in the project's own settings; an environment with only
        // worktrees still lists them so it never shows up empty.
        members: mainCheckouts.length > 0 ? mainCheckouts : checkouts,
      };
    },
  );
  const caption = `${sections.length} environment${sections.length === 1 ? "" : "s"}`;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        closeDelay={100}
        render={
          <button
            type="button"
            aria-label={`Show where this project is set up: ${caption}`}
            className="cursor-help underline decoration-border underline-offset-2 outline-hidden hover:text-foreground focus-visible:text-foreground"
          />
        }
      >
        {caption}
      </PopoverTrigger>
      <PopoverPopup align="start" padding="none" className="w-max max-w-xl">
        <div className="divide-y divide-border/60">
          {sections.map((section) => (
            <section key={section.environmentId} className="px-3 py-2.5">
              <h4 className="flex items-center gap-1.5 pb-1.5 text-xs font-medium text-muted-foreground">
                <EnvironmentMachineIcon
                  aria-hidden
                  kind={section.machine}
                  className="size-3.5 shrink-0"
                />
                <span className="min-w-0 truncate">{section.label}</span>
              </h4>
              <ul role="list" className="text-sm">
                {section.members.map((member) => (
                  <li
                    key={member.physicalProjectKey}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1"
                  >
                    <span className="min-w-0 truncate font-mono text-xs text-foreground">
                      {member.workspaceRoot}
                    </span>
                    <DiffFilePathCopyButton filePath={member.workspaceRoot} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
