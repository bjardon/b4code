# b4-code

b4-code is Bruno's fork of [T3 Code](https://github.com/pingdotgg/t3code). It runs as a personal server next to the official app, which stays on the upstream release for work.

Build status lives in [TODO.md](TODO.md). Decisions, learnings, and dead ends live in the [devlog](https://app.notion.com/p/3f0d5cfe81be80dba8d0e54ca07573b4).

## Branches

`main` is upstream's `main` plus the fork's commits on top. Upstream never touches `fork/`, so keep fork tooling here and keep edits to upstream files small. Every edited upstream line can conflict on the next rebase.

To pull in upstream, run this from a development checkout with `main` checked out and clean:

```sh
node fork/b4.ts sync
```

It rebases `main` onto `upstream/main` and force-pushes it with a lease.

## Branding

The B4 Code name and the desktop app's identity live in `branding.patch`, not in commits to upstream files. `main` keeps upstream's code and tests, and `deploy` applies the patch in the deploy clone before building. The patch covers the web app's name and title, plus the desktop app's name, bundle id (`dev.b4code.desktop`), URL schemes (`b4code`), Electron profile (`b4code`), and data home (`~/.b4-code/desktop`).

When a sync moves the lines it touches, `deploy` stops at `git apply`. Apply the old patch by hand in a development checkout, fix the conflicts, and regenerate it with `git diff > fork/branding.patch`.

## Running the server

The server runs from a dedicated clone at `~/.b4-code/src` and keeps its data in `~/.b4-code/userdata`. It never reads `~/.t3`, which belongs to the official app. Development worktrees stay separate, so switching branches never changes the running server.

First-time setup on a machine with Node 24 or newer, `vp`, and the provider CLIs on `PATH`. On macOS, `deploy` also builds the desktop app, which needs the Xcode command line tools and Rust with the host's target (`brew install rustup`, then `rustup default stable`).

```sh
git clone git@github.com:bjardon/t3code.git ~/.b4-code/src
cd ~/.b4-code/src
node fork/b4.ts deploy
node fork/b4.ts service
node fork/b4.ts pair
```

`deploy` resets the clone to `origin/main`, applies `branding.patch`, installs dependencies, builds the server and web client, and restarts the service. It refuses to run from any other checkout because the reset discards local changes.

On macOS, `deploy` also builds the B4 Code desktop app and installs it to `/Applications`. It quits a running copy first and reopens it afterward. Like respawken, the app is signed ad-hoc, and a local build has no quarantine flag, so Gatekeeper opens it without a prompt. B4 Code is a client only. Its local environment starts off, so it runs no server of its own. Connect it to this server with `pair`. It stays separate from the official T3 Code app, which keeps working for the work setup.

`service` writes a launchd agent on macOS or a systemd user unit on Linux, using the Node that ran it and the current `PATH`. Rerun it after changing `B4_PORT`, `B4_HOST`, or `B4_HOME`, or after moving Node. On Linux, the unit only survives logout with lingering enabled (`loginctl enable-linger`).

`pair` prints a one-time link. Paste it into **Settings → Connections → Add environment** in the desktop app, or open it in a browser to use the fork's own web UI.

| Variable  | Default      | Use                                  |
| --------- | ------------ | ------------------------------------ |
| `B4_HOME` | `~/.b4-code` | Data directory and deploy clone root |
| `B4_PORT` | `3780`       | HTTP and WebSocket port              |
| `B4_HOST` | `127.0.0.1`  | Bind address, such as a tailnet IP   |

## Things that behave differently from upstream

- Don't use `t3 service install`, `t3 update`, or the app's **Update server** button for this server. They download upstream's release archive and would replace the fork. Update with `deploy`.
- The official desktop and mobile apps show their own bundled UI. Fork UI changes appear in B4 Code and in the browser at the server's address, not in the official apps.
- Clients refuse to connect when their orchestration protocol differs from the server's. If the official app updates past the fork, run `sync` and `deploy`.
