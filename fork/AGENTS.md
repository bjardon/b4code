# b4-code

This checkout is b4-code, Bruno's personal fork of T3 Code. It is a Personal Experiment: built outcome-first with minimal process. It gets more discipline than a disposable experiment because every change sits on top of a large upstream codebase that keeps moving.

Where things live:

- `fork/README.md` explains what the fork is and how to sync, deploy, and pair.
- `fork/TODO.md` is the build status. It tracks user-visible outcomes, not engineering tasks.
- The [Notion devlog](https://app.notion.com/p/3f0d5cfe81be80dba8d0e54ca07573b4) holds durable decisions, learnings, and dead ends.

## How this file relates to the root AGENTS.md

The root `AGENTS.md` is upstream's guide and stays the guide for the code itself: Effect services, the taste rules, verifying, dev servers, test data, and the three ways to hurt yourself. Follow it.

This file wins where the two conflict:

- **Bruno is the maintainer.** Read "we", "us", and "maintainers" in upstream's guide as Bruno.
- **Surfaces.** Bruno runs the official T3 Code desktop and mobile apps as clients and the fork as a server. Server changes reach every client. UI changes only appear in the fork's web UI (the browser at the server's address) until the fork ships its own desktop build. Say which surface a change lands on. Providers in use are Claude, Codex, and Cursor. Other adapters don't need a decision.
- **Docs.** Fork knowledge goes in `fork/` or the devlog, never `docs/`. Changing upstream's docs only creates rebase conflicts.
- **Pull requests.** Nothing goes to `pingdotgg/t3code`. The fork ships by landing on `main`, not through pull requests.

## Keeping the fork rebaseable

`main` is `upstream/main` plus the fork's commits on top, and `node fork/b4.ts sync` rebases it. Every edited upstream line is a possible conflict on the next sync.

- Put fork-only code and tooling in `fork/` when it can live there.
- When an upstream file must change, make the smallest edit that works. Prefer adding a new file and a one-line hook over rewriting shared code.
- Write the code to upstream's standard: strict types, its lint rules, focused tests for backend behavior. Fork code that fights upstream's conventions breaks on the next sync.
- When a sync conflicts, keep upstream's version and reapply the fork's intent on top of it. Record a conflict in the devlog only when it changed how the fork works.

## Guardrails

- `~/.t3` belongs to the official app and Bruno's work setup. Never start a server against it or write to it.
- `~/.b4-code/userdata` is the live b4-code database. Upstream's rules for `~/.t3/userdata` apply to it too: copying from it is fine, writing to it is not.
- `~/.b4-code/src` is the deploy clone. Never develop in it. `deploy` resets it hard.
- Never push to `upstream`.

## Build, run, verify

- Develop in a worktree with upstream's dev workflow (`vp i`, `vp run dev`). Worktree state stays in its own `.t3`.
- Verify with upstream's rules: targeted `vp test run`, lint, and typecheck for the files you touched. For `fork/b4.ts`, typecheck it against `tsconfig.base.json` and run `vp lint fork/b4.ts`.
- The running server is `http://127.0.0.1:3780` on the Mac (launchd agent `dev.b4code.server`, logs in `~/.b4-code/logs/service.log`).

## Wrap-up

- Implement and verify freely, but ship only after Bruno explicitly accepts the work or asks to wrap up.
- Before shipping, verify the accepted user-visible behavior in proportion to the change.
- Refresh `fork/TODO.md` so completed, partial, and unfinished outcomes stay accurate.
- Land the work on `main` and push it. Commits carry a `Co-Authored-By` trailer. Opening a pull request is not a completed wrap-up.
- Deploy it: `cd ~/.b4-code/src && node fork/b4.ts deploy`. Shipped means the running server has the change.
- Don't add required review, branch protection, or other quality gates unless Bruno asks for them.
- Consider the devlog at every wrap-up. Append only durable decisions, learnings, or dead ends, under `### YYYY-MM-DD — Title`, with a `<Agent Name> posting on behalf of Bruno` line. Don't repeat what Git history or `TODO.md` already record.
- If any step is blocked, report wrap-up as incomplete and name the blocker. Don't record the work as shipped.
