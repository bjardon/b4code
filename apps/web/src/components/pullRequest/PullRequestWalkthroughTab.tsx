import { FileDiff } from "@pierre/diffs/react";
import {
  splitPatchHunks,
  type EnvironmentId,
  type PullRequestDetailView,
  type PullRequestRef,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import {
  fnv1a32,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import {
  buildWalkthroughSections,
  type WalkthroughSectionView,
} from "./pullRequestWalkthrough.logic";
import { PullRequestDiffStat } from "./pullRequestPresentation";

/** Matches the server's own cap: past it the walkthrough covers what it read. */
const MAX_DIFF_SLICES = 20;

/** Every slice of the pull request's patch, read one after another until the host says done. */
function useWholePullRequestPatch(environmentId: EnvironmentId, reference: PullRequestRef) {
  const scopeKey = JSON.stringify([
    environmentId,
    reference.projectId,
    reference.host ?? null,
    reference.repository,
    reference.number,
  ]);
  const [state, setState] = useState<{
    readonly key: string;
    readonly cursor: string | null;
    readonly patches: ReadonlyArray<string>;
    readonly done: boolean;
  }>({ key: scopeKey, cursor: null, patches: [], done: false });
  const current =
    state.key === scopeKey ? state : { key: scopeKey, cursor: null, patches: [], done: false };
  const query = useEnvironmentQuery(
    current.done
      ? null
      : pullRequestEnvironment.diff({
          environmentId,
          input: { ...reference, ...(current.cursor === null ? {} : { cursor: current.cursor }) },
        }),
  );
  useEffect(() => {
    const page = query.data;
    if (page === null || current.done) return;
    setState((previous) => {
      const base =
        previous.key === scopeKey
          ? previous
          : { key: scopeKey, cursor: null, patches: [], done: false };
      if (base.cursor !== current.cursor || base.done) return previous;
      const patches = [...base.patches, page.patch];
      const done = page.nextCursor === null || patches.length >= MAX_DIFF_SLICES;
      return { key: scopeKey, cursor: done ? base.cursor : page.nextCursor, patches, done };
    });
  }, [current.cursor, current.done, query.data, scopeKey]);
  return {
    patches: current.done ? current.patches : null,
    error: query.error,
    retry: query.refresh,
  };
}

function WalkthroughSection({
  section,
  index,
  scopeKey,
  environmentId,
  cwd,
}: {
  section: WalkthroughSectionView;
  index: number;
  scopeKey: string;
  environmentId: EnvironmentId;
  cwd: string;
}) {
  const [open, setOpen] = useState(section.kind === "core");
  const settings = useClientSettings();
  const { resolvedTheme } = useTheme();
  return (
    <Collapsible open={open} onOpenChange={setOpen} render={<section aria-label={section.title} />}>
      <div className="sticky top-0 z-10 border-b border-border/60 bg-background">
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left">
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="text-xs text-muted-foreground tabular-nums">{index + 1}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {section.title}
          </span>
          <Badge variant={section.kind === "core" ? "info" : "secondary"} size="sm">
            {section.kind === "core" ? "Core" : "Supporting"}
          </Badge>
          <span className="shrink-0 text-xs text-muted-foreground">
            {section.fileCount} {section.fileCount === 1 ? "file" : "files"}
          </span>
          <PullRequestDiffStat
            additions={section.additions}
            deletions={section.deletions}
            className="shrink-0 font-mono text-xs"
          />
        </CollapsibleTrigger>
      </div>
      <div className="px-4 pt-3 pb-1 text-sm">
        <PullRequestMarkdown text={section.summary} cwd={cwd} environmentId={environmentId} />
      </div>
      <CollapsiblePanel>
        <WalkthroughSectionDiff
          patch={section.patch}
          cacheKey={`pull-request-walkthrough:${scopeKey}:${index}:${resolvedTheme}`}
          options={{
            collapsed: false,
            diffStyle: settings.diffLayout === "split" ? "split" : "unified",
            lineDiffType: "none",
            overflow: settings.wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            themeType: resolvedTheme,
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
          }}
        />
      </CollapsiblePanel>
    </Collapsible>
  );
}

function WalkthroughSectionDiff({
  patch,
  cacheKey,
  options,
}: {
  patch: string;
  cacheKey: string;
  options: NonNullable<Parameters<typeof FileDiff>[0]["options"]>;
}) {
  const renderable = useMemo(
    () => getRenderablePatch(patch, `${cacheKey}:${fnv1a32(patch)}`),
    [patch, cacheKey],
  );
  if (renderable === null) return null;
  if (renderable.kind === "raw") {
    return (
      <pre className="mx-4 mb-3 overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
        {renderable.text}
      </pre>
    );
  }
  return (
    <div className="space-y-2 px-4 pb-4">
      {renderable.files.map((fileDiff) => (
        <FileDiff key={resolveFileDiffPath(fileDiff)} fileDiff={fileDiff} options={options} />
      ))}
    </div>
  );
}

function WalkthroughStatus({
  title,
  detail,
  pending = false,
  onRetry,
}: {
  title: string;
  detail?: string;
  pending?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div
      className="flex min-h-48 flex-col items-center justify-center gap-2 px-4 py-10 text-center"
      role="status"
      aria-live="polite"
    >
      {pending ? <Spinner size="md" tone="muted" /> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail ? <p className="max-w-md text-xs text-muted-foreground">{detail}</p> : null}
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshIcon aria-hidden size="sm" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The pull request read as a walkthrough: an overview, then sections that pair why a part of the
 * change exists with its hunks, core first. Opening the tab asks for the walkthrough; the server
 * writes it once per head commit and every later reader shares it.
 */
function PullRequestWalkthroughTab({
  environmentId,
  reference,
  detail,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
}) {
  const headSha = detail.headSha;
  const walkthroughInput = { ...reference, ...(headSha === undefined ? {} : { headSha }) };
  const walkthroughQuery = useEnvironmentQuery(
    pullRequestEnvironment.walkthrough({ environmentId, input: walkthroughInput }),
  );
  const regenerateWalkthrough = useAtomCommand(pullRequestEnvironment.regenerateWalkthrough, {
    label: "Regenerate walkthrough",
  });
  const [regenerating, setRegenerating] = useState(false);
  const regenerate = async () => {
    setRegenerating(true);
    const result = await regenerateWalkthrough({
      environmentId,
      input: { ...walkthroughInput, regenerate: true },
    });
    setRegenerating(false);
    if (result._tag === "Success") walkthroughQuery.refresh();
  };
  const diff = useWholePullRequestPatch(environmentId, reference);
  const files = useMemo(
    () => (diff.patches === null ? null : diff.patches.flatMap(splitPatchHunks)),
    [diff.patches],
  );
  const walkthrough = walkthroughQuery.data;
  const sections = useMemo(
    () =>
      walkthrough === null || files === null ? null : buildWalkthroughSections(walkthrough, files),
    [walkthrough, files],
  );
  const scopeKey = `${environmentId}:${reference.repository}#${reference.number}:${walkthrough?.headSha ?? ""}`;

  if (walkthrough === null) {
    if (walkthroughQuery.error !== null && !walkthroughQuery.isPending) {
      return (
        <WalkthroughStatus
          title="Could not write the walkthrough"
          detail={walkthroughQuery.error}
          onRetry={walkthroughQuery.refresh}
        />
      );
    }
    return (
      <WalkthroughStatus
        pending
        title="Generating walkthrough…"
        detail="Usually takes a minute or two."
      />
    );
  }
  if (sections === null) {
    return diff.error !== null ? (
      <WalkthroughStatus title="Could not load the diff" detail={diff.error} onRetry={diff.retry} />
    ) : (
      <WalkthroughStatus pending title="Loading the diff" />
    );
  }

  const stale =
    walkthrough.headSha !== null && headSha !== undefined && walkthrough.headSha !== headSha;
  return (
    <div className="h-full overflow-y-auto pb-24">
      <div className="space-y-3 border-b border-border/60 px-4 py-4">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-xs font-medium text-muted-foreground">
            Walkthrough · {sections.length} {sections.length === 1 ? "section" : "sections"}
          </h2>
          <Button
            size="xs"
            variant="ghost"
            disabled={regenerating}
            onClick={() => void regenerate()}
          >
            {regenerating ? <Spinner aria-hidden /> : <RefreshIcon aria-hidden size="sm" />}
            {regenerating ? "Regenerating..." : "Regenerate"}
          </Button>
        </div>
        {stale ? (
          <p className="text-xs text-warning-foreground">
            Written for an earlier push. Regenerate to cover the latest changes.
          </p>
        ) : null}
        <div className="text-sm">
          <PullRequestMarkdown
            text={walkthrough.overview}
            cwd={detail.workspaceRoot}
            environmentId={environmentId}
          />
        </div>
      </div>
      <DiffWorkerPoolProvider>
        {sections.map((section, index) => (
          <WalkthroughSection
            key={`${section.title}:${fnv1a32(section.patch)}`}
            section={section}
            index={index}
            scopeKey={scopeKey}
            environmentId={environmentId}
            cwd={detail.workspaceRoot}
          />
        ))}
      </DiffWorkerPoolProvider>
    </div>
  );
}

export default PullRequestWalkthroughTab;
