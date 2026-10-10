import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PullRequestRef } from "./pullRequest.ts";

/**
 * A walkthrough reads a pull request as a few narrated sections instead of a file list: the core of
 * the change first, supporting and lower-signal edits after. Sections point at hunks rather than
 * carrying them, so the walkthrough stays small on the socket and the client fills each section from
 * the patch it already loads over HTTP.
 */
export const PullRequestWalkthroughInput = Schema.Struct({
  ...PullRequestRef.fields,
  /** The head the reader is looking at. A push moves it, which asks for a new walkthrough. */
  headSha: Schema.optional(TrimmedNonEmptyString),
  /** Discard the cached walkthrough for this head and write a new one. */
  regenerate: Schema.optional(Schema.Boolean),
});
export type PullRequestWalkthroughInput = typeof PullRequestWalkthroughInput.Type;

/** One hunk of the patch: its file, and its `@@` header, or `""` for a file with no hunks. */
export const PullRequestWalkthroughHunkRef = Schema.Struct({
  path: Schema.String,
  hunk: Schema.String,
});
export type PullRequestWalkthroughHunkRef = typeof PullRequestWalkthroughHunkRef.Type;

export const PullRequestWalkthroughSectionKind = Schema.Literals(["core", "supporting"]);
export type PullRequestWalkthroughSectionKind = typeof PullRequestWalkthroughSectionKind.Type;

export const PullRequestWalkthroughSection = Schema.Struct({
  title: Schema.String,
  /** Markdown explaining why this part of the change exists. */
  summary: Schema.String,
  kind: PullRequestWalkthroughSectionKind,
  hunks: Schema.Array(PullRequestWalkthroughHunkRef),
});
export type PullRequestWalkthroughSection = typeof PullRequestWalkthroughSection.Type;

export const PullRequestWalkthrough = Schema.Struct({
  /** The head the walkthrough was written against, when the host reports one. */
  headSha: Schema.NullOr(Schema.String),
  overview: Schema.String,
  sections: Schema.Array(PullRequestWalkthroughSection),
});
export type PullRequestWalkthrough = typeof PullRequestWalkthrough.Type;

export interface PatchHunk {
  /** The `@@` line, or `""` for the one stand-in hunk of a file that has none. */
  readonly header: string;
  /** The hunk's lines, header included. */
  readonly text: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface PatchFile {
  readonly path: string;
  /** Everything from `diff --git` up to the first hunk. */
  readonly header: string;
  readonly hunks: ReadonlyArray<PatchHunk>;
}

function unquotePath(raw: string): string {
  const path = raw.split("\t")[0] ?? raw;
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

function resolvePatchPath(headerLines: ReadonlyArray<string>): string {
  let oldPath: string | null = null;
  for (const line of headerLines) {
    if (line.startsWith("+++ ")) {
      const path = unquotePath(line.slice(4));
      if (path !== "/dev/null") return path.replace(/^b\//, "");
    } else if (line.startsWith("--- ")) {
      const path = unquotePath(line.slice(4));
      if (path !== "/dev/null") oldPath = path.replace(/^a\//, "");
    } else if (line.startsWith("rename to ")) {
      return line.slice("rename to ".length);
    }
  }
  if (oldPath !== null) return oldPath;
  const match = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(headerLines[0] ?? "");
  return match?.[2] ?? headerLines[0] ?? "";
}

/**
 * Splits a git patch into files and hunks. The server numbers hunks with this for the model and
 * the client rebuilds sections with it, so both sides must split the same text the same way.
 */
export function splitPatchHunks(patch: string): ReadonlyArray<PatchFile> {
  const files: PatchFile[] = [];
  let headerLines: string[] | null = null;
  let hunks: Array<{ header: string; lines: string[] }> = [];

  const flush = () => {
    if (headerLines === null) return;
    files.push({
      path: resolvePatchPath(headerLines),
      header: headerLines.join("\n"),
      hunks:
        hunks.length === 0
          ? [{ header: "", text: "", additions: 0, deletions: 0 }]
          : hunks.map(({ header, lines }) => {
              let additions = 0;
              let deletions = 0;
              for (const line of lines) {
                if (line.startsWith("+")) additions += 1;
                else if (line.startsWith("-")) deletions += 1;
              }
              return { header, text: [header, ...lines].join("\n"), additions, deletions };
            }),
    });
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      headerLines = [line];
      hunks = [];
    } else if (headerLines === null) {
      continue;
    } else if (line.startsWith("@@ ")) {
      hunks.push({ header: line, lines: [] });
    } else if (hunks.length > 0) {
      hunks[hunks.length - 1]!.lines.push(line);
    } else {
      headerLines.push(line);
    }
  }
  flush();
  return files;
}

/** The hunk's identity across server and client. */
export function patchHunkKey(path: string, hunk: string): string {
  return `${path}\u0000${hunk}`;
}

/** A patch holding only the given hunks, grouped under their files in first-seen order. */
export function buildPatchFromHunks(
  files: ReadonlyArray<PatchFile>,
  refs: ReadonlyArray<PullRequestWalkthroughHunkRef>,
): string {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const selected = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (!byPath.get(ref.path)?.hunks.some((hunk) => hunk.header === ref.hunk)) continue;
    const hunks = selected.get(ref.path) ?? new Set<string>();
    hunks.add(ref.hunk);
    selected.set(ref.path, hunks);
  }
  const parts: string[] = [];
  for (const [path, headers] of selected) {
    const file = byPath.get(path)!;
    parts.push(file.header);
    // File order, not reference order: a patch with hunks out of order does not parse.
    for (const hunk of file.hunks) {
      if (hunk.header !== "" && headers.has(hunk.header)) parts.push(hunk.text);
    }
  }
  return parts.join("\n");
}
