import {
  buildPatchFromHunks,
  patchHunkKey,
  type PatchFile,
  type PullRequestWalkthrough,
  type PullRequestWalkthroughHunkRef,
  type PullRequestWalkthroughSectionKind,
} from "@t3tools/contracts";

export interface WalkthroughSectionView {
  readonly title: string;
  readonly summary: string;
  readonly kind: PullRequestWalkthroughSectionKind;
  /** The section's hunks as one patch, files in first-mentioned order. */
  readonly patch: string;
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Fills the walkthrough's sections from the patch on screen. A hunk the walkthrough names but the patch no
 * longer has is skipped, and a hunk the walkthrough never names (a push since, or a diff longer than
 * the walkthrough read) is gathered into a last section, so every line of the diff stays reachable.
 */
export function buildWalkthroughSections(
  walkthrough: PullRequestWalkthrough,
  files: ReadonlyArray<PatchFile>,
): ReadonlyArray<WalkthroughSectionView> {
  const hunks = new Map<string, { additions: number; deletions: number }>();
  for (const file of files) {
    for (const hunk of file.hunks) hunks.set(patchHunkKey(file.path, hunk.header), hunk);
  }
  const placed = new Set<string>();
  const view = (
    title: string,
    summary: string,
    kind: PullRequestWalkthroughSectionKind,
    refs: ReadonlyArray<PullRequestWalkthroughHunkRef>,
  ): WalkthroughSectionView | null => {
    const present = refs.filter((ref) => {
      const key = patchHunkKey(ref.path, ref.hunk);
      if (!hunks.has(key) || placed.has(key)) return false;
      placed.add(key);
      return true;
    });
    if (present.length === 0) return null;
    let additions = 0;
    let deletions = 0;
    for (const ref of present) {
      const stat = hunks.get(patchHunkKey(ref.path, ref.hunk));
      additions += stat?.additions ?? 0;
      deletions += stat?.deletions ?? 0;
    }
    return {
      title,
      summary,
      kind,
      patch: buildPatchFromHunks(files, present),
      fileCount: new Set(present.map((ref) => ref.path)).size,
      additions,
      deletions,
    };
  };

  const sections = walkthrough.sections.flatMap((section) => {
    const built = view(section.title, section.summary, section.kind, section.hunks);
    return built === null ? [] : [built];
  });
  const rest = view(
    "Not in the walkthrough",
    "Changes the walkthrough does not cover, usually from a push after it was written.",
    "supporting",
    files.flatMap((file) => file.hunks.map((hunk) => ({ path: file.path, hunk: hunk.header }))),
  );
  return rest === null ? sections : [...sections, rest];
}
