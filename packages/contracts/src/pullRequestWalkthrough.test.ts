import { describe, expect, it } from "vite-plus/test";

import { buildPatchFromHunks, splitPatchHunks } from "./pullRequestWalkthrough.ts";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-old",
  "+new",
  " same",
  "@@ -10,1 +10,2 @@ function tail()",
  " keep",
  "+added",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/old.png b/new.png",
  "similarity index 100%",
  "rename from old.png",
  "rename to new.png",
].join("\n");

describe("splitPatchHunks", () => {
  it("splits files and hunks and names each file by its new path", () => {
    const files = splitPatchHunks(PATCH);
    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "gone.ts", "new.png"]);
    expect(files[0]!.hunks.map((hunk) => [hunk.header, hunk.additions, hunk.deletions])).toEqual([
      ["@@ -1,2 +1,2 @@", 1, 1],
      ["@@ -10,1 +10,2 @@ function tail()", 1, 0],
    ]);
    expect(files[1]!.hunks[0]!.deletions).toBe(1);
  });

  it("gives a file without hunks one stand-in so it can still be placed", () => {
    const rename = splitPatchHunks(PATCH)[2]!;
    expect(rename.hunks).toEqual([{ header: "", text: "", additions: 0, deletions: 0 }]);
  });
});

describe("buildPatchFromHunks", () => {
  it("keeps file order within a file and drops unknown hunks", () => {
    const files = splitPatchHunks(PATCH);
    const patch = buildPatchFromHunks(files, [
      { path: "src/a.ts", hunk: "@@ -10,1 +10,2 @@ function tail()" },
      { path: "src/a.ts", hunk: "@@ -1,2 +1,2 @@" },
      { path: "src/a.ts", hunk: "@@ -99 +99 @@" },
      { path: "new.png", hunk: "" },
    ]);
    expect(patch).toBe(
      [...PATCH.split("\n").slice(0, 11), ...PATCH.split("\n").slice(17)].join("\n"),
    );
  });

  it("round-trips a whole patch", () => {
    const files = splitPatchHunks(PATCH);
    const all = files.flatMap((file) =>
      file.hunks.map((hunk) => ({ path: file.path, hunk: hunk.header })),
    );
    expect(buildPatchFromHunks(files, all)).toBe(PATCH);
  });
});
