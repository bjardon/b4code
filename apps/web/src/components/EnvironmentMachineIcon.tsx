import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { CloudIcon, LaptopIcon, MonitorIcon, ServerIcon, type LucideProps } from "lucide-react";
import type { FunctionComponent, SVGProps } from "react";

import { cn } from "../lib/utils";
import { projectIconColorClassName } from "../projectIconColors";
import { environmentSummaries } from "../state/presentation";
import { LinuxIcon } from "./Icons";

function LucideLike(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}

function MacMiniIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LucideLike {...props}>
      <rect width="18" height="12" x="3" y="6" rx="2.5" />
      <circle cx="7.5" cy="12" r="1" fill="currentColor" stroke="none" />
    </LucideLike>
  );
}

function MacStudioIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LucideLike {...props}>
      <rect width="18" height="14" x="3" y="5" rx="2" />
      <path d="M7 15h.01M11 15h.01M15 15h.01" />
    </LucideLike>
  );
}

const ICON_BY_KIND: Record<EnvironmentMachineKind, FunctionComponent<LucideProps>> = {
  server: ServerIcon,
  cloud: CloudIcon,
  linux: LinuxIcon,
  desktop: MonitorIcon,
  laptop: LaptopIcon,
  "mac-mini": MacMiniIcon,
  "mac-studio": MacStudioIcon,
};

export const ENVIRONMENT_MACHINE_KIND_LABELS: Record<EnvironmentMachineKind, string> = {
  server: "Server",
  cloud: "Cloud VM",
  linux: "Linux/WSL",
  desktop: "Desktop",
  laptop: "Laptop",
  "mac-mini": "Mini PC",
  "mac-studio": "Workstation",
};

export function environmentMachineIcon(
  kind: EnvironmentMachineKind,
): FunctionComponent<LucideProps> {
  return ICON_BY_KIND[kind];
}

/** With an `environmentId`, the icon wears the color chosen for that environment. */
export function EnvironmentMachineIcon({
  kind,
  environmentId,
  className,
  ...props
}: LucideProps & {
  readonly kind: EnvironmentMachineKind;
  readonly environmentId?: EnvironmentId | null | undefined;
}) {
  const Icon = ICON_BY_KIND[kind];
  const colors = useAtomValue(environmentSummaries.iconColorByIdAtom);
  const color = environmentId ? colors.get(environmentId) : undefined;
  return (
    <Icon
      {...props}
      // stroke-current displaces any stroke-* color a call site set for the muted look.
      className={
        color ? cn(className, projectIconColorClassName(color), "stroke-current") : className
      }
    />
  );
}
