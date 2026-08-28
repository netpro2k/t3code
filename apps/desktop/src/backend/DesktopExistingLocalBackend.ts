import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";
const PROBE_TIMEOUT = Duration.millis(1_500);

const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  devUrl: Schema.optional(Schema.String),
  desktopAttachToken: Schema.optional(Schema.NonEmptyString),
  startedAt: Schema.String,
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

const decodePersistedServerRuntimeState = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

export interface ExistingLocalBackend {
  readonly origin: string;
  readonly port: number;
  readonly pid: number;
  readonly desktopAttachToken: string | null;
}

export const requiresExistingLocalBackend = (input: {
  readonly isDevelopment: boolean;
  readonly platform: NodeJS.Platform;
}): boolean => !input.isDevelopment && input.platform !== "win32";

// signal 0 delivers nothing; it only reports whether the pid exists. EPERM
// means it exists but belongs to another user, which still counts as alive.
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const probeExistingBackend = (
  origin: string,
): Effect.Effect<Option.Option<ExecutionEnvironmentDescriptor>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(new URL(WELL_KNOWN_ENVIRONMENT_PATH, origin).toString());
    const response = yield* client.execute(request).pipe(
      Effect.timeout(PROBE_TIMEOUT),
      Effect.mapError(() => Option.none<ExecutionEnvironmentDescriptor>()),
    );
    const descriptor = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.mapError(() => Option.none<ExecutionEnvironmentDescriptor>()),
    );
    return Option.some(descriptor);
  }).pipe(Effect.orElseSucceed(() => Option.none<ExecutionEnvironmentDescriptor>()));

export const discoverExistingLocalBackend = Effect.fn("desktop.existingLocalBackend.discover")(
  function* (statePath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem.readFileString(statePath).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.succeed(Option.none<string>()),
        onSuccess: (contents) => Effect.succeed(Option.some(contents)),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<ExistingLocalBackend>();
    }
    const trimmed = raw.value.trim();
    if (trimmed.length === 0) {
      return Option.none<ExistingLocalBackend>();
    }
    const state = decodePersistedServerRuntimeState(trimmed);
    if (Option.isNone(state)) {
      return Option.none<ExistingLocalBackend>();
    }
    if (!isProcessAlive(state.value.pid)) {
      return Option.none<ExistingLocalBackend>();
    }
    const probed = yield* probeExistingBackend(state.value.origin);
    if (Option.isNone(probed)) {
      return Option.none<ExistingLocalBackend>();
    }
    return Option.some({
      origin: state.value.origin,
      port: state.value.port,
      pid: state.value.pid,
      desktopAttachToken: state.value.desktopAttachToken ?? null,
    } satisfies ExistingLocalBackend);
  },
);
