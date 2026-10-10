import * as Schema from "effect/Schema";

import { limitSection } from "./textGenerationUtils.ts";

export interface PrWalkthroughPromptInput {
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
  /** Every hunk under its id, as the server numbered them. */
  hunks: string;
}

/** Asks for a review walkthrough: the patch's hunks grouped by purpose and narrated, core first. */
export function buildPrWalkthroughPrompt(input: PrWalkthroughPromptInput) {
  const prompt = [
    "You write review walkthroughs for pull requests.",
    "A walkthrough groups the change by purpose so a reviewer reads the core of the implementation first and the supporting edits after.",
    "Return a JSON object with keys: overview, sections.",
    "Each section has: title, summary, kind, hunkIds.",
    "Rules:",
    "- overview: 2-4 sentences of markdown on what the pull request does and how it is put together",
    "- group hunks by the purpose they serve, not by file: a section may span files, and one file's hunks may land in different sections",
    "- kind is 'core' for the parts that carry the change, 'supporting' for tests, plumbing, types, renames, config, docs, generated or mechanical edits",
    "- list core sections first, in the order a reviewer should read them, then supporting sections",
    "- title: a short phrase naming what the section does",
    "- summary: 1-3 sentences of markdown on why this part exists and what to check in it, not a restatement of the code",
    "- hunkIds: ids from the list below; every id appears in exactly one section",
    "- prefer 2-8 sections; a small change may need only one",
    "",
    `Title: ${input.title}`,
    `Base branch: ${input.baseBranch}`,
    `Head branch: ${input.headBranch}`,
    "",
    "Description:",
    limitSection(input.body.trim() || "(none)", 8_000),
    "",
    "Hunks:",
    input.hunks,
  ].join("\n");

  const outputSchema = Schema.Struct({
    overview: Schema.String,
    sections: Schema.Array(
      Schema.Struct({
        title: Schema.String,
        summary: Schema.String,
        kind: Schema.Literals(["core", "supporting"]),
        hunkIds: Schema.Array(Schema.String),
      }),
    ),
  });

  return { prompt, outputSchema };
}
