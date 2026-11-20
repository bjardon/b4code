import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

export function EnvironmentRenameDialog({
  environmentId,
  label,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:w-96">
        {/* The popup mounts per open, so the draft starts from the current label each time. */}
        <EnvironmentRenameForm
          environmentId={environmentId}
          label={label}
          onClose={() => onOpenChange(false)}
        />
      </DialogPopup>
    </Dialog>
  );
}

function EnvironmentRenameForm({
  environmentId,
  label,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState(label);
  const [saving, setSaving] = useState(false);
  const setLabel = useAtomCommand(environmentCatalog.setLabel, "Rename environment");
  const canSave = draft.trim() !== "" && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const result = await setLabel({ environmentId, label: draft });
    setSaving(false);
    if (result._tag !== "Failure") onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <T>Rename environment</T>
        </DialogTitle>
        <DialogDescription>
          <T>The new name applies on this device only.</T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            autoFocus
            aria-label={gt("Environment name")}
            value={draft}
            disabled={saving}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={onClose}>
          <T>Cancel</T>
        </Button>
        <Button disabled={!canSave} onClick={() => void save()}>
          <T>Save</T>
        </Button>
      </DialogFooter>
    </>
  );
}
