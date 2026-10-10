/**
 * Review walkthroughs for pull requests: the patch's hunks grouped by purpose and narrated by the
 * text generation model, core of the change first. A walkthrough is written once per head commit and
 * kept in memory and under the state directory, so reopening a pull request, another client,
 * or a restart reads it back instead of paying for it again.
 *
 * @module PullRequestWalkthroughService
 */
import {
  type PatchFile,
  type PullRequestDetail,
  PullRequestWalkthrough,
  type PullRequestWalkthroughHunkRef,
  type PullRequestWalkthroughInput,
  type PullRequestDiffResult,
  type PullRequestWalkthroughSection,
  PullRequestOperationError,
  type PullRequestRef,
  splitPatchHunks,
} from "@t3tools/contracts";
import type { PrWalkthroughGenerationResult } from "@t3tools/provider-core/server/textGeneration";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as PullRequestService from "./PullRequestService.ts";

/** A walkthrough past this many diff slices covers what it read; the Code tab still has the rest. */
const MAX_DIFF_SLICES = 20;
/** Lines of one hunk the model sees. The id and file still place a longer hunk. */
const HUNK_LINE_LIMIT = 120;
/** Characters of hunk content in the prompt. Past it, hunks are listed by header alone. */
const PROMPT_HUNK_BUDGET = 160_000;
const MEMORY_ENTRIES = 100;

export class PullRequestWalkthroughService extends Context.Service<
  PullRequestWalkthroughService,
  {
    readonly walkthrough: (
      input: PullRequestWalkthroughInput,
    ) => Effect.Effect<PullRequestWalkthrough, PullRequestService.PullRequestError>;
  }
>()("t3/pullRequest/PullRequestWalkthroughService") {}

/** Every hunk under a short id, with as much of its content as the budget allows. */
export function numberHunks(files: ReadonlyArray<PatchFile>): {
  readonly listing: string;
  readonly ids: ReadonlyMap<string, PullRequestWalkthroughHunkRef>;
} {
  const ids = new Map<string, PullRequestWalkthroughHunkRef>();
  const blocks: string[] = [];
  let budget = PROMPT_HUNK_BUDGET;
  for (const file of files) {
    for (const hunk of file.hunks) {
      const id = `h${ids.size + 1}`;
      ids.set(id, { path: file.path, hunk: hunk.header });
      const label = `[${id}] ${file.path} (+${hunk.additions} -${hunk.deletions})`;
      if (hunk.header === "") {
        blocks.push(`${label}\n${file.header}`);
        continue;
      }
      const lines = hunk.text.split("\n");
      const shown =
        lines.length > HUNK_LINE_LIMIT
          ? [...lines.slice(0, HUNK_LINE_LIMIT), `[${lines.length - HUNK_LINE_LIMIT} more lines]`]
          : lines;
      const content = shown.join("\n");
      if (content.length <= budget) {
        budget -= content.length;
        blocks.push(`${label}\n${content}`);
      } else {
        blocks.push(`${label}\n${hunk.header}\n[content omitted]`);
      }
    }
  }
  return { listing: blocks.join("\n\n"), ids };
}

/**
 * Holds the model to its ids: unknown ones are dropped, a hunk claimed twice stays with its
 * first section, and hunks it left out are gathered at the end so nothing goes unreviewed.
 */
export function resolveWalkthrough(
  generated: PrWalkthroughGenerationResult,
  ids: ReadonlyMap<string, PullRequestWalkthroughHunkRef>,
  headSha: string | null,
): PullRequestWalkthrough {
  const claimed = new Set<string>();
  const take = (hunkIds: ReadonlyArray<string>) =>
    hunkIds.flatMap((id) => {
      const ref = ids.get(id.trim());
      if (ref === undefined || claimed.has(id.trim())) return [];
      claimed.add(id.trim());
      return [ref];
    });
  const sections: PullRequestWalkthroughSection[] = generated.sections
    .map((section) => ({ ...section, hunks: take(section.hunkIds) }))
    .filter((section) => section.hunks.length > 0)
    .map(({ title, summary, kind, hunks }) => ({ title, summary, kind, hunks }));
  // Core first even when the model interleaves them; the order within each kind is its own.
  sections.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "core" ? -1 : 1));
  const leftover = [...ids].filter(([id]) => !claimed.has(id)).map(([, ref]) => ref);
  if (leftover.length > 0) {
    sections.push({
      title: "Other changes",
      summary: "Changes the walkthrough did not place in a section.",
      kind: "supporting",
      hunks: leftover,
    });
  }
  return { headSha, overview: generated.overview, sections };
}

const decodeWalkthroughFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PullRequestWalkthrough),
);
const encodeWalkthroughFile = Schema.encodeEffect(Schema.fromJsonString(PullRequestWalkthrough));

const toWalkthroughError = (detail: string, cause?: unknown) =>
  new PullRequestOperationError({
    operation: "walkthrough",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

export const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const directory = path.join(config.stateDir, "pull-request-walkthroughs");
  const inFlight = new Map<
    string,
    Deferred.Deferred<PullRequestWalkthrough, PullRequestService.PullRequestError>
  >();

  const fileFor = (key: string) =>
    path.join(directory, `${Buffer.from(key).toString("base64url")}.json`);

  // The cache is a convenience: a file that cannot be read or written means a fresh walkthrough.
  const readStored = (key: string) =>
    fileSystem
      .readFileString(fileFor(key))
      .pipe(Effect.flatMap(decodeWalkthroughFile), Effect.option);
  const store = (key: string, walkthrough: PullRequestWalkthrough) =>
    encodeWalkthroughFile(walkthrough).pipe(
      Effect.flatMap((text) =>
        fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(Effect.andThen(fileSystem.writeFileString(fileFor(key), text))),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not store pull request walkthrough", { cause }),
      ),
    );

  const readDiff = Effect.fn("PullRequestWalkthroughService.readDiff")(function* (
    ref: PullRequestRef,
  ) {
    const files: PatchFile[] = [];
    let cursor: string | null = null;
    for (let slice = 0; slice < MAX_DIFF_SLICES; slice += 1) {
      const page: PullRequestDiffResult = yield* pullRequests.diff({
        ...ref,
        ...(cursor === null ? {} : { cursor }),
      });
      files.push(...splitPatchHunks(page.patch));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    return files;
  });

  const generate = Effect.fn("PullRequestWalkthroughService.generate")(function* (
    ref: PullRequestRef,
    detail: PullRequestDetail,
  ) {
    const files = yield* readDiff(ref);
    const headSha = detail.headSha ?? null;
    if (files.length === 0) {
      return {
        headSha,
        overview: "This pull request has no changes to walkthrough.",
        sections: [],
      };
    }
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings.pipe(
        Effect.mapError((cause) =>
          toWalkthroughError("Could not read the server settings.", cause),
        ),
      ),
      ref.projectId,
    ).settings;
    const generatePrWalkthrough = textGeneration.generatePrWalkthrough;
    if (generatePrWalkthrough === undefined) {
      return yield* toWalkthroughError("This server cannot write pull request walkthroughs.");
    }
    const { listing, ids } = numberHunks(files);
    const generated = yield* generatePrWalkthrough({
      cwd: detail.workspaceRoot,
      title: detail.title,
      body: detail.body,
      baseBranch: detail.baseBranch,
      headBranch: detail.headBranch,
      hunks: listing,
      modelSelection: settings.textGenerationModelSelection,
    }).pipe(Effect.mapError((error) => toWalkthroughError(error.detail, error)));
    return resolveWalkthrough(generated, ids, headSha);
  });

  const walkthrough: PullRequestWalkthroughService["Service"]["walkthrough"] = Effect.fn(
    "PullRequestWalkthroughService.walkthrough",
  )(function* (input) {
    const { headSha: _headSha, regenerate, ...ref } = input;
    const detail = yield* pullRequests.detail(ref);
    const key = [
      ref.projectId,
      ref.host?.toLowerCase() ?? "",
      ref.repository.toLowerCase(),
      ref.number,
      detail.headSha ?? detail.updatedAt,
    ].join("\n");
    const running = inFlight.get(key);
    if (running !== undefined && (regenerate !== true || !(yield* Deferred.isDone(running)))) {
      return yield* Deferred.await(running);
    }
    if (regenerate !== true) {
      const stored = yield* readStored(key);
      if (stored._tag === "Some") return stored.value;
    }

    const result = yield* Deferred.make<
      PullRequestWalkthrough,
      PullRequestService.PullRequestError
    >();
    inFlight.delete(key);
    inFlight.set(key, result);
    if (inFlight.size > MEMORY_ENTRIES) {
      const oldest = inFlight.keys().next().value;
      if (oldest !== undefined) inFlight.delete(oldest);
    }
    // Written in the server's scope, not the request's: a reader who leaves the tab while the
    // model works still finds the walkthrough waiting when they come back.
    yield* generate(ref, detail).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Exit.isSuccess(exit)
          ? store(key, exit.value).pipe(Effect.andThen(Deferred.done(result, exit)))
          : Effect.sync(() => {
              if (inFlight.get(key) === result) inFlight.delete(key);
            }).pipe(Effect.andThen(Deferred.done(result, exit))),
      ),
      Effect.forkIn(scope),
    );
    return yield* Deferred.await(result);
  });

  return PullRequestWalkthroughService.of({ walkthrough });
});

export const layer = Layer.effect(PullRequestWalkthroughService, make);
