import { BoatSandboxError, type BoatSandboxPower } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type { BoatConfigFile } from "./BoatConfig.ts";

const DEFAULT_API_URL = "https://boat.dev/api/v1";

/** The fields of boat's sandbox object this server reads. */
export const BoatApiSandbox = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  archiveAfter: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(Schema.NullOr(Schema.Unknown)),
  stop: Schema.optional(
    Schema.NullOr(Schema.Struct({ status: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});
export type BoatApiSandbox = typeof BoatApiSandbox.Type;

const SandboxEnvelope = Schema.Struct({ sandbox: BoatApiSandbox });
const ErrorEnvelope = Schema.Struct({
  message: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
});
const decodeSandbox = Schema.decodeUnknownOption(Schema.fromJsonString(SandboxEnvelope));
const decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorEnvelope));

/**
 * boat reports a stopped sandbox as `archived` (its CLI prints `stopped`), and
 * `idle` and `running` only describe queued agent prompts, so both are up.
 */
export function sandboxPower(sandbox: BoatApiSandbox): BoatSandboxPower {
  switch (sandbox.state) {
    case "ready":
    case "idle":
    case "running":
      return sandbox.stop?.status === "pending" || sandbox.stop?.status === "failing"
        ? "stopping"
        : "running";
    case "archiving":
      return "stopping";
    case "archived":
    case "stopped":
      return "stopped";
    case "error":
    case "cancelled":
      return "failed";
    default:
      return "starting";
  }
}

export function sandboxStopsAt(sandbox: BoatApiSandbox): DateTime.Utc | null {
  if (sandboxPower(sandbox) !== "running" || !sandbox.archiveAfter) return null;
  return Option.getOrNull(DateTime.make(sandbox.archiveAfter));
}

export function sandboxError(sandbox: BoatApiSandbox): string | null {
  const error = sandbox.error;
  if (error === null || error === undefined) return null;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

const failure = (message: string) => new BoatSandboxError({ message });

/** boat's REST API (https://docs.boat.dev/api/v1), with the key from `boat.json`. */
export const makeBoatApi = Effect.fn("BoatApi.make")(function* (config: BoatConfigFile) {
  const httpClient = yield* HttpClient.HttpClient;
  const base = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");

  const send = Effect.fn("BoatApi.send")(function* (
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ) {
    const request = HttpClientRequest.make(method)(`${base}${path}`).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json",
        authorization: `Bearer ${config.apiKey}`,
      }),
      body === undefined ? (request) => request : HttpClientRequest.bodyJsonUnsafe(body),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.timeout("20 seconds"),
      Effect.mapError((cause) => failure(`boat.dev did not answer: ${cause.message}`)),
    );
    const text = yield* response.text.pipe(
      Effect.mapError((cause) => failure(`boat.dev sent an unreadable answer: ${cause.message}`)),
    );
    if (response.status >= 400) {
      const detail = Option.getOrUndefined(decodeError(text));
      return yield* failure(
        `boat.dev refused ${method} ${path} (${response.status}${
          detail?.code ? ` ${detail.code}` : ""
        }): ${detail?.message ?? text.slice(0, 200)}`,
      );
    }
    return text;
  });

  const sandboxFrom = (text: string) =>
    Option.match(decodeSandbox(text), {
      onNone: () => Effect.fail(failure("boat.dev answered without a sandbox.")),
      onSome: ({ sandbox }) => Effect.succeed(sandbox),
    });

  return {
    get: (id: string) =>
      send("GET", `/sandboxes/${encodeURIComponent(id)}`).pipe(Effect.flatMap(sandboxFrom)),
    resume: (id: string) =>
      send("POST", `/sandboxes/${encodeURIComponent(id)}/resume`, {}).pipe(Effect.asVoid),
    stop: (id: string) =>
      send("POST", `/sandboxes/${encodeURIComponent(id)}/stop`, {}).pipe(Effect.asVoid),
    /** Moves the auto-stop deadline to `ttlSeconds` from now. */
    extend: (id: string, ttlSeconds: number) =>
      send("PATCH", `/sandboxes/${encodeURIComponent(id)}`, { ttlSeconds }).pipe(Effect.asVoid),
  };
});

export type BoatApi = Effect.Success<ReturnType<typeof makeBoatApi>>;
