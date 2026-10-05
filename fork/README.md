# b4-code

b4-code is Bruno's fork of [T3 Code](https://github.com/pingdotgg/t3code). It runs as a personal server next to the official app, which stays on the upstream release for work.

## Branches

`main` is upstream's `main` plus the fork's commits on top. Upstream never touches `fork/`, so keep fork tooling here and keep edits to upstream files small. Every edited upstream line can conflict on the next rebase.

To pull in upstream, run this from a development checkout with `main` checked out and clean:

```sh
node fork/b4.ts sync
```

It rebases `main` onto `upstream/main` and force-pushes it with a lease.

## Running the server

The server runs from a dedicated clone at `~/.b4-code/src` and keeps its data in `~/.b4-code/userdata`. It never reads `~/.t3`, which belongs to the official app. Development worktrees stay separate, so switching branches never changes the running server.

First-time setup on a machine with Node 24 or newer, `vp`, and the provider CLIs on `PATH`:

```sh
git clone git@github.com:bjardon/t3code.git ~/.b4-code/src
cd ~/.b4-code/src
node fork/b4.ts deploy
node fork/b4.ts service
node fork/b4.ts pair
```

`deploy` resets the clone to `origin/main`, installs dependencies, builds the server and web client, and restarts the service. It refuses to run from any other checkout because the reset discards local commits.

`service` writes a launchd agent on macOS or a systemd user unit on Linux, using the Node that ran it and the current `PATH`. Rerun it after changing `B4_PORT`, `B4_HOST`, or `B4_HOME`, or after moving Node. On Linux, the unit only survives logout with lingering enabled (`loginctl enable-linger`).

`pair` prints a one-time link. Paste it into **Settings → Connections → Add environment** in the desktop app, or open it in a browser to use the fork's own web UI.

| Variable  | Default      | Use                                  |
| --------- | ------------ | ------------------------------------ |
| `B4_HOME` | `~/.b4-code` | Data directory and deploy clone root |
| `B4_PORT` | `3780`       | HTTP and WebSocket port              |
| `B4_HOST` | `127.0.0.1`  | Bind address, such as a tailnet IP   |

## Things that behave differently from upstream

- Don't use `t3 service install`, `t3 update`, or the app's **Update server** button for this server. They download upstream's release archive and would replace the fork. Update with `deploy`.
- The official desktop and mobile apps show their own bundled UI. Fork UI changes and the B4 Code name appear only in the browser at the server's address, or in a desktop build made from this repo.
- Clients refuse to connect when their orchestration protocol differs from the server's. If the official app updates past the fork, run `sync` and `deploy`.
