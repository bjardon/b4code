import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { ProjectFavicon } from "../ProjectFavicon";
import { InlineButton } from "../ui/button";
import { useOptionalSettingsScope } from "./SettingsScopeContext";

/**
 * `Settings / Projects / <project>` on a project's page, where `Projects`
 * returns to the list. The list itself ends at `Projects`.
 */
export function ProjectsBreadcrumbTrail() {
  const scope = useOptionalSettingsScope();
  const projectKey = scope?.search.project;
  const project = projectKey
    ? scope.groups.find((group) => group.projectKey === projectKey)
    : undefined;
  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      <WorkspaceBreadcrumbItem>Settings</WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator />
      {scope && projectKey ? (
        <>
          <WorkspaceBreadcrumbItem>
            <InlineButton
              tone="muted"
              onClick={() =>
                scope.selectScope(scope.search.machine ? { machine: scope.search.machine } : {})
              }
            >
              Projects
            </InlineButton>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current className="gap-1.5">
            {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
            <WorkspaceBreadcrumbText>
              {project?.displayName ?? "Unavailable project"}
            </WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbItem>
        </>
      ) : (
        <WorkspaceBreadcrumbItem current>Projects</WorkspaceBreadcrumbItem>
      )}
    </WorkspaceBreadcrumb>
  );
}
