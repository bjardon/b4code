import { splitPatchHunks } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildWalkthroughSections } from "./pullRequestWalkthrough.logic";

const files = splitPatchHunks(
  [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1 +1,2 @@",
    " x",
    "+y",
  ].join("\n"),
);

describe("buildWalkthroughSections", () => {
  it("fills sections from the patch and keeps hunks the walkthrough missed reachable", () => {
    const sections = buildWalkthroughSections(
      {
        headSha: null,
        overview: "",
        sections: [
          {
            title: "Swap",
            summary: "Why.",
            kind: "core",
            hunks: [
              { path: "a.ts", hunk: "@@ -1 +1 @@" },
              { path: "gone.ts", hunk: "@@ -1 +1 @@" },
            ],
          },
          { title: "Stale", summary: "", kind: "supporting", hunks: [{ path: "x", hunk: "" }] },
        ],
      },
      files,
    );
    expect(
      sections.map((section) => [section.title, section.fileCount, section.additions]),
    ).toEqual([
      ["Swap", 1, 1],
      ["Not in the walkthrough", 1, 1],
    ]);
    expect(sections[0]!.patch).toBe(
      ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-a", "+b"].join(
        "\n",
      ),
    );
  });
});
