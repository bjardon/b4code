import {
  BoatSandboxError,
  type BoatSandboxListResult,
  type BoatSandboxStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerConfig from "../config.ts";
import {
  type BoatApiSandbox,
  makeBoatApi,
  sandboxError,
  sandboxPower,
  sandboxStopsAt,
} from "./BoatApi.ts";
import { type BoatManagedSandbox, readBoatConfig } from "./BoatConfig.ts";

/** boat is ready in ~20 s and b4-code answers about a minute later; allow for a slow host. */
const WAKE_TIMEOUT = "6 minutes";
const POLL_INTERVAL = "2 seconds";
/** A sandbox that answered this recently is not probed again before a forwarded call. */
const ANSWERED_FRESH_MS = 30_000;

/**
 * Powers the boat.dev sandboxes listed in this server's `boat.json`, each the
 * host of another environment. Clients and agents here wake one before they
 * act there, since a stopped sandbox cannot answer for itself.
 */
export class BoatSandboxes extends Context.Service<
  BoatSandboxes,
  {
    readonly list: Effect.Effect<BoatSandboxListResult, BoatSandboxError>;
    /** Resumes a stopped sandbox and returns once its server answers. */
    readonly wake: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<BoatSandboxStatus, BoatSandboxError>;
    readonly stop: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<BoatSandboxStatus, BoatSandboxError>;
    /** Wakes `environmentId` when it is a sandbox this server powers; any other is left alone. */
    readonly ensureAwake: (environmentId: EnvironmentId) => Effect.Effect<void, BoatSandboxError>;
    readonly sandboxFor: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<BoatManagedSandbox>, BoatSandboxError>;
  }
>()("t3/boat/BoatSandboxes") {}

const notManaged = (environmentId: EnvironmentId) =>
  new BoatSandboxError({
    message: `Environment ${environmentId} is not a boat sandbox this server powers. Add it with \`node fork/b4.ts boat configure\`.`,
  });

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;
  const wakes = yield* Ref.make<
    ReadonlyMap<string, Deferred.Deferred<BoatSandboxStatus, BoatSandboxError>>
  >(new Map());
  const answeredAt = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const provided = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig | HttpClient.HttpClient
    >,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig.ServerConfig, serverConfig),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  const loadConfig = provided(readBoatConfig());

  const resolve = Effect.fn("BoatSandboxes.resolve")(function* (environmentId: EnvironmentId) {
    const config = yield* loadConfig;
    if (Option.isNone(config)) return Option.none();
    const sandbox = config.value.sandboxes?.find(
      (candidate) => candidate.environmentId === environmentId,
    );
    if (sandbox === undefined) return Option.none();
    const api = yield* provided(makeBoatApi(config.value));
    return Option.some({ sandbox, api });
  });

  const require = (environmentId: EnvironmentId) =>
    resolve(environmentId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(notManaged(environmentId)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const serverAnswers = Effect.fn("BoatSandboxes.serverAnswers")(function* (
    sandbox: BoatManagedSandbox,
  ) {
    const url = `${sandbox.url.replace(/\/+$/, "")}/.well-known/t3/environment`;
    const answered = yield* httpClient.execute(HttpClientRequest.get(url)).pipe(
      Effect.map((response) => response.status < 500),
      Effect.timeout("4 seconds"),
      Effect.orElseSucceed(() => false),
    );
    if (answered) {
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(answeredAt, (map) => new Map(map).set(sandbox.environmentId, now));
    }
    return answered;
  });

  const statusOf = (
    sandbox: BoatManagedSandbox,
    remote: BoatApiSandbox,
    serverAnswering: boolean,
  ): BoatSandboxStatus => ({
    environmentId: sandbox.environmentId,
    sandboxId: sandbox.id,
    label: sandbox.label,
    power: sandboxPower(remote),
    serverAnswering,
    stopsAt: sandboxStopsAt(remote),
    error: sandboxError(remote),
  });

  const readStatus = Effect.fn("BoatSandboxes.readStatus")(function* (
    sandbox: BoatManagedSandbox,
    api: Effect.Success<ReturnType<typeof makeBoatApi>>,
  ) {
    const remote = yield* api.get(sandbox.id);
    const answering = sandboxPower(remote) === "running" ? yield* serverAnswers(sandbox) : false;
    return statusOf(sandbox, remote, answering);
  });

  const list = Effect.gen(function* () {
    const config = yield* loadConfig;
    if (Option.isNone(config)) return { sandboxes: [] };
    const api = yield* provided(makeBoatApi(config.value));
    const sandboxes = yield* Effect.forEach(
      config.value.sandboxes ?? [],
      (sandbox) => readStatus(sandbox, api),
      { concurrency: "unbounded" },
    );
    return { sandboxes };
  }).pipe(Effect.withSpan("BoatSandboxes.list"));

  const pollUntil = <A>(
    read: Effect.Effect<A, BoatSandboxError>,
    done: (value: A) => boolean,
    what: string,
  ) =>
    read.pipe(
      Effect.repeat({ until: done, schedule: Schedule.spaced(POLL_INTERVAL) }),
      Effect.timeoutOrElse({
        duration: WAKE_TIMEOUT,
        orElse: () =>
          Effect.fail(new BoatSandboxError({ message: `Timed out waiting for ${what}.` })),
      }),
    );

  const runWake = Effect.fn("BoatSandboxes.runWake")(function* (environmentId: EnvironmentId) {
    const { sandbox, api } = yield* require(environmentId);
    yield* Effect.annotateCurrentSpan({ "boat.sandbox_id": sandbox.id });
    let remote = yield* api.get(sandbox.id);
    if (sandboxPower(remote) === "stopping") {
      remote = yield* pollUntil(
        api.get(sandbox.id),
        (next) => sandboxPower(next) !== "stopping",
        `${sandbox.label} to finish stopping`,
      );
    }
    const power = sandboxPower(remote);
    if (power === "failed") {
      return yield* new BoatSandboxError({
        message: `${sandbox.label} is in boat's ${remote.state} state: ${sandboxError(remote) ?? "no reason given"}.`,
      });
    }
    if (power === "stopped") yield* api.resume(sandbox.id);
    if (power !== "running") {
      remote = yield* pollUntil(
        api.get(sandbox.id),
        (next) => sandboxPower(next) === "running" || sandboxPower(next) === "failed",
        `${sandbox.label} to start`,
      );
      if (sandboxPower(remote) === "failed") {
        return yield* new BoatSandboxError({
          message: `${sandbox.label} failed to start: ${sandboxError(remote) ?? remote.state}.`,
        });
      }
    }
    yield* pollUntil(
      serverAnswers(sandbox),
      (answered) => answered,
      `${sandbox.label}'s server to answer`,
    );
    return statusOf(sandbox, remote, true);
  });

  // One wake per sandbox: later callers share it, and it outlives a caller that gives up.
  const wake = Effect.fn("BoatSandboxes.wake")(function* (environmentId: EnvironmentId) {
    const created = yield* Deferred.make<BoatSandboxStatus, BoatSandboxError>();
    const pending = yield* Ref.modify(wakes, (map) => {
      const existing = map.get(environmentId);
      return existing === undefined
        ? [created, new Map(map).set(environmentId, created)]
        : [existing, map];
    });
    if (pending === created) {
      yield* runWake(environmentId).pipe(
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(created, exit)),
        Effect.ensuring(
          Ref.update(wakes, (map) => {
            const next = new Map(map);
            next.delete(environmentId);
            return next;
          }),
        ),
        Effect.forkIn(scope),
      );
    }
    return yield* Deferred.await(pending);
  });

  const stop = Effect.fn("BoatSandboxes.stop")(function* (environmentId: EnvironmentId) {
    const { sandbox, api } = yield* require(environmentId);
    yield* Effect.annotateCurrentSpan({ "boat.sandbox_id": sandbox.id });
    const remote = yield* api.get(sandbox.id);
    if (sandboxPower(remote) === "running" || sandboxPower(remote) === "starting") {
      yield* api.stop(sandbox.id);
    }
    yield* Ref.update(answeredAt, (map) => {
      const next = new Map(map);
      next.delete(environmentId);
      return next;
    });
    return statusOf(sandbox, yield* api.get(sandbox.id), false);
  });

  const ensureAwake = Effect.fn("BoatSandboxes.ensureAwake")(function* (
    environmentId: EnvironmentId,
  ) {
    const resolved = yield* resolve(environmentId);
    if (Option.isNone(resolved)) return;
    const last = (yield* Ref.get(answeredAt)).get(environmentId);
    if (last !== undefined && (yield* Clock.currentTimeMillis) - last < ANSWERED_FRESH_MS) return;
    if (yield* serverAnswers(resolved.value.sandbox)) return;
    yield* wake(environmentId);
  });

  return BoatSandboxes.of({
    list,
    wake,
    stop,
    ensureAwake,
    sandboxFor: Effect.fn("BoatSandboxes.sandboxFor")(function* (environmentId) {
      return Option.map(yield* resolve(environmentId), ({ sandbox }) => sandbox);
    }),
  });
});

export const layer = Layer.effect(BoatSandboxes, make);
