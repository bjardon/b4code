import {
  AuthSettingsWriteScope,
  ENVIRONMENT_MACHINE_KINDS,
  isEnvironmentMachineKind,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { PROJECT_ICON_COLORS } from "../../projectIconColors";
import { useEnvironmentScope } from "../../state/session";
import { ENVIRONMENT_MACHINE_KIND_LABELS, EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";

const DEFAULT_ICON_COLOR = "default";

export function resolveEnvironmentIconPickerLock(
  input: {
    readonly serverConfig: Pick<ServerConfig, "environment"> | null;
    readonly operateAccess: "granted" | "denied" | "pending";
  },
  resolve: MessageResolver = m,
): string | null {
  if (input.serverConfig === null) {
    return resolve(msg("Connect to this environment to change its icon."));
  }
  if (input.operateAccess !== "granted") {
    return resolve(msg("Your session on this environment cannot change its settings."));
  }
  return null;
}

export function EnvironmentIconMenu({
  environmentId,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: Pick<ServerConfig, "environment" | "settings"> | null;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const operateAccess = useEnvironmentScope(environmentId, AuthSettingsWriteScope)
    ? "granted"
    : "denied";
  const lock = resolveEnvironmentIconPickerLock({ serverConfig, operateAccess }, resolve);
  const detected = serverConfig?.environment.platform.machine ?? "server";
  const resolved = resolveEnvironmentMachineKind(serverConfig);

  const colorLock =
    lock === null && serverConfig?.environment.capabilities.environmentIconColor !== true
      ? gt("This environment's server is too old to keep an icon color. Update it to choose one.")
      : lock;
  const selectedColor = PROJECT_ICON_COLORS.find(
    (option) => option.value === serverConfig?.settings?.environmentIconColor,
  );

  return (
    <>
      <MenuSub>
        <MenuSubTrigger>
          <EnvironmentMachineIcon kind={resolved} environmentId={environmentId} />
          <T>Icon</T>
        </MenuSubTrigger>
        <MenuSubPopup>
          {lock !== null ? (
            <>
              <MenuItem disabled className="whitespace-normal">
                {lock}
              </MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          <MenuRadioGroup
            value={resolved}
            onValueChange={(next) => {
              if (lock !== null || !isEnvironmentMachineKind(next)) return;
              updateSettings({ environmentIcon: next === detected ? null : next });
            }}
          >
            {ENVIRONMENT_MACHINE_KINDS.map((kind) => (
              <MenuRadioItem key={kind} value={kind} disabled={lock !== null}>
                <span className="flex min-w-0 items-center gap-2">
                  <EnvironmentMachineIcon kind={kind} className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {resolve(ENVIRONMENT_MACHINE_KIND_LABELS[kind])}
                  </span>
                  {kind === detected ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {serverConfig?.environment.platform.machine
                        ? gt("detected", { $context: "machine kind detected automatically" })
                        : gt("default", { $context: "machine kind used when none is detected" })}
                    </span>
                  ) : null}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSubPopup>
      </MenuSub>
      <MenuSub>
        <MenuSubTrigger>
          <ColorSwatch className={selectedColor?.swatchClassName} />
          <T>Icon color</T>
        </MenuSubTrigger>
        <MenuSubPopup>
          {colorLock !== null ? (
            <>
              <MenuItem disabled className="whitespace-normal">
                {colorLock}
              </MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          <MenuRadioGroup
            value={selectedColor?.value ?? DEFAULT_ICON_COLOR}
            onValueChange={(next) => {
              if (colorLock !== null) return;
              const option = PROJECT_ICON_COLORS.find((color) => color.value === next);
              updateSettings({ environmentIconColor: option?.value ?? null });
            }}
          >
            <MenuRadioItem value={DEFAULT_ICON_COLOR} disabled={colorLock !== null}>
              <span className="flex min-w-0 items-center gap-2">
                <ColorSwatch />
                {gt("Default", { $context: "icon color used when none is chosen" })}
              </span>
            </MenuRadioItem>
            {PROJECT_ICON_COLORS.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} disabled={colorLock !== null}>
                <span className="flex min-w-0 items-center gap-2">
                  <ColorSwatch className={option.swatchClassName} />
                  {resolve(option.label)}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSubPopup>
      </MenuSub>
    </>
  );
}

function ColorSwatch({ className }: { readonly className?: string | undefined }) {
  return (
    <span
      aria-hidden
      className={cn("size-3.5 shrink-0 rounded-full border border-foreground/24", className)}
    />
  );
}
