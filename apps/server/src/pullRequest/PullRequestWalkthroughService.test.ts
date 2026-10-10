import { splitPatchHunks } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { numberHunks, resolveWalkthrough } from "./PullRequestWalkthroughService.ts";

const files = splitPatchHunks(
  [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "@@ -9 +9 @@",
    "-c",
    "+d",
    "diff --git a/a.test.ts b/a.test.ts",
    "--- a/a.test.ts",
    "+++ b/a.test.ts",
    "@@ -1 +1,2 @@",
    " x",
    "+y",
  ].join("\n"),
);

describe("numberHunks", () => {
  it("numbers every hunk in patch order", () => {
    const { listing, ids } = numberHunks(files);
    expect([...ids.keys()]).toEqual(["h1", "h2", "h3"]);
    expect(ids.get("h3")).toEqual({ path: "a.test.ts", hunk: "@@ -1 +1,2 @@" });
    expect(listing).toContain("[h2] a.ts (+1 -1)\n@@ -9 +9 @@\n-c\n+d");
  });
});

describe("resolveWalkthrough", () => {
  const { ids } = numberHunks(files);

  it("drops unknown and repeated ids, puts core first, and gathers what the model left out", () => {
    const walkthrough = resolveWalkthrough(
      {
        overview: "Swaps a for b.",
        sections: [
          { title: "Tests", summary: "", kind: "supporting", hunkIds: ["h3", "h9"] },
          { title: "Swap", summary: "Why.", kind: "core", hunkIds: ["h1", "h3"] },
          { title: "Empty", summary: "", kind: "core", hunkIds: ["nope"] },
        ],
      },
      ids,
      "abc",
    );
    expect(walkthrough.headSha).toBe("abc");
    expect(walkthrough.sections.map((section) => [section.title, section.hunks.length])).toEqual([
      ["Swap", 1],
      ["Tests", 1],
      ["Other changes", 1],
    ]);
    expect(walkthrough.sections[2]!.hunks).toEqual([{ path: "a.ts", hunk: "@@ -9 +9 @@" }]);
  });
});
