import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Settings2Icon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { readLocalApi } from "../../localApi";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

type ProjectEntry = {
  group: SidebarProjectSnapshot;
  members: SidebarProjectSnapshot["memberProjects"];
  /** The group spans environments outside the selected one. */
  partial: boolean;
  lastActivityAt: string;
};

/**
 * A path only identifies a checkout on one environment, so "All environments"
 * shows where the project is set up instead.
 */
function ProjectEntryDescription({
  entry,
  machine,
}: {
  entry: ProjectEntry;
  machine: string | undefined;
}) {
  if (!machine) {
    const environmentCount = new Set(entry.members.map((member) => member.environmentId)).size;
    return `${environmentCount} environment${environmentCount === 1 ? "" : "s"}`;
  }
  if (entry.members.length > 1) return `${entry.members.length} checkouts`;
  return <span className="block truncate">{entry.members[0]!.workspaceRoot}</span>;
}

/**
 * Every project at the selected environment, most recently active first.
 * Configure opens the project's settings page; Remove deletes its entries.
 */
export function ProjectsList() {
  const { groups, search, selectScope } = useSettingsScope();
  const threads = useThreadShells();
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });

  const entries = useMemo((): ProjectEntry[] => {
    const lastThreadActivity = new Map<string, string>();
    for (const thread of threads) {
      const key = `${thread.environmentId}:${thread.projectId}`;
      const current = lastThreadActivity.get(key);
      if (current === undefined || thread.updatedAt > current) {
        lastThreadActivity.set(key, thread.updatedAt);
      }
    }
    return groups
      .flatMap((group) => {
        const members = group.memberProjects.filter(
          (member) => !search.machine || member.environmentId === search.machine,
        );
        if (members.length === 0) return [];
        const lastActivityAt = members.reduce((latest, member) => {
          const threadActivity = lastThreadActivity.get(`${member.environmentId}:${member.id}`);
          const memberActivity =
            threadActivity !== undefined && threadActivity > member.updatedAt
              ? threadActivity
              : member.updatedAt;
          return memberActivity > latest ? memberActivity : latest;
        }, "");
        return [
          {
            group,
            members,
            partial: members.length < group.memberProjects.length,
            lastActivityAt,
          },
        ];
      })
      .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  }, [groups, search.machine, threads]);

  const removeProject = async ({ group, members, partial }: ProjectEntry) => {
    const api = readLocalApi();
    if (!api) return;
    const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
    const projectThreads = threads.filter((thread) =>
      memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
    );
    const targetKind = partial ? "checkout" : "project";
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        [
          projectThreads.length > 0
            ? `Remove ${targetKind} "${group.displayName}" and delete its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}?`
            : `Remove ${targetKind} "${group.displayName}"?`,
          ...(members.length === 1
            ? [`Path: ${members[0]!.workspaceRoot}`]
            : [`This removes ${members.length} grouped project entries.`]),
          "This permanently clears conversation history for its threads and any archived threads.",
          partial
            ? "Entries on other environments are unaffected."
            : "This removes only the project entries, not the files on disk.",
          "This action cannot be undone.",
        ].join("\n"),
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;

    const draftStore = useComposerDraftStore.getState();
    for (const member of members) {
      const result = mapAtomCommandResult(
        await deleteProject({
          environmentId: member.environmentId,
          input: { projectId: member.id, force: true },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Failed to remove "${member.title}"`,
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      const projectRef = scopeProjectRef(member.environmentId, member.id);
      releaseProjectDraftUploads(
        projectRef,
        projectThreads
          .filter(
            (thread) =>
              thread.environmentId === member.environmentId && thread.projectId === member.id,
          )
          .map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      );
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
      if (projectDraftThread) draftStore.clearDraftThread(projectDraftThread.draftId);
      draftStore.clearProjectDraftThreadId(projectRef);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Projects">
        {entries.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Add a project from the sidebar to manage it here.
          </p>
        ) : (
          entries.map((entry) => (
            <SettingsRow
              key={entry.group.projectKey}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <ProjectFavicon project={entry.group} className="size-4 shrink-0" />
                  <span className="truncate">{entry.group.displayName}</span>
                </span>
              }
              description={<ProjectEntryDescription entry={entry} machine={search.machine} />}
              control={
                <div className="flex items-center gap-1">
                  <span className="me-2 text-xs text-muted-foreground tabular-nums">
                    {formatRelativeTimeLabel(entry.lastActivityAt)}
                  </span>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          aria-label={`Configure ${entry.group.displayName}`}
                          onClick={() =>
                            selectScope({
                              project: entry.group.projectKey,
                              ...(search.machine ? { machine: search.machine } : {}),
                            })
                          }
                        />
                      }
                    >
                      <Settings2Icon />
                    </TooltipTrigger>
                    <TooltipPopup>Configure</TooltipPopup>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost-destructive"
                          aria-label={`Remove ${entry.group.displayName}`}
                          onClick={() => void removeProject(entry)}
                        />
                      }
                    >
                      <Trash2Icon />
                    </TooltipTrigger>
                    <TooltipPopup>Remove</TooltipPopup>
                  </Tooltip>
                </div>
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
