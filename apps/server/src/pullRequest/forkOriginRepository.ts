import type { OrchestrationProjectShell } from "@t3tools/contracts";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

/**
 * b4-code: a checkout with both `upstream` and `origin` lists, opens and acts on the pull
 * requests of `origin`, the fork it pushes to, instead of the upstream repository its identity
 * otherwise names.
 */
export function preferOriginRepository(
  project: OrchestrationProjectShell,
): OrchestrationProjectShell {
  const identity = project.repositoryIdentity;
  const origin = identity?.origin;
  if (!identity || origin?.remoteUrl === undefined) return project;
  const path = origin.displayName ?? origin.canonicalKey.split("/").slice(1).join("/");
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const [owner] = segments;
  const name = segments.at(-1);
  const provider = sourceControlDefinitions.recognizeRemote(origin.remoteUrl)?.kind;
  return {
    ...project,
    repositoryIdentity: {
      canonicalKey: origin.canonicalKey,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: origin.remoteUrl },
      ...(identity.rootPath === undefined ? {} : { rootPath: identity.rootPath }),
      ...(identity.linkedWorktree === undefined ? {} : { linkedWorktree: identity.linkedWorktree }),
      ...(path ? { displayName: path } : {}),
      ...(provider === undefined ? {} : { provider }),
      ...(owner === undefined ? {} : { owner }),
      ...(name === undefined ? {} : { name }),
    },
  };
}
