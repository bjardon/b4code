import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { SettingsRow } from "./settingsLayout";

/** Read-only checkout paths for a project scoped to one environment. */
export function ProjectPathRows({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  return members.map((member) => (
    <SettingsRow
      key={member.physicalProjectKey}
      title="Path"
      description="Where this project lives on the selected environment."
      control={
        <InputGroup className="w-full sm:w-80">
          <InputGroupInput
            size="sm"
            font="mono"
            readOnly
            aria-label="Project path"
            value={member.workspaceRoot}
          />
          <InputGroupAddon align="inline-end">
            <DiffFilePathCopyButton filePath={member.workspaceRoot} />
          </InputGroupAddon>
        </InputGroup>
      }
    />
  ));
}
