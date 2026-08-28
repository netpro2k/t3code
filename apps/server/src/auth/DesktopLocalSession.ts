import { AuthSessionId, AuthStandardClientScopes } from "@t3tools/contracts";
import {
  DESKTOP_LOCAL_SESSION_FILE,
  DesktopLocalSessionJson,
} from "@t3tools/shared/desktopLocalSession";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SessionStore from "./SessionStore.ts";

const decodeSession = Schema.decodeEffect(DesktopLocalSessionJson);
const encodeSession = Schema.encodeEffect(DesktopLocalSessionJson);
const decodeExpiration = Schema.decodeEffect(Schema.DateTimeUtcFromString);

class DesktopLocalSessionRenewalError extends Schema.TaggedError<DesktopLocalSessionRenewalError>()(
  "DesktopLocalSessionRenewalError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not renew Desktop's saved local session.";
  }
}

export class DesktopLocalSession extends Context.Service<
  DesktopLocalSession,
  { readonly renew: Effect.Effect<void, DesktopLocalSessionRenewalError> }
>()("t3/auth/DesktopLocalSession") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const sessions = yield* SessionStore.SessionStore;
  const repository = yield* AuthSessions.AuthSessionRepository;
  const sessionPath = path.join(config.stateDir, DESKTOP_LOCAL_SESSION_FILE);

  const renew = Effect.gen(function* () {
    // Only the offline installer opts a T3 home in by provisioning this private file.
    if (!(yield* fs.exists(sessionPath))) return;
    const saved = yield* decodeSession(yield* fs.readFileString(sessionPath));
    const now = yield* DateTime.now;
    const expiresAt = yield* decodeExpiration(saved.expiresAt);
    if (
      DateTime.toEpochMillis(expiresAt) >
      DateTime.toEpochMillis(now) + Duration.toMillis(Duration.days(7))
    )
      return;
    const row = yield* repository.getById({ sessionId: AuthSessionId.make(saved.sessionId) });
    if (
      Option.isNone(row) ||
      row.value.revokedAt !== null ||
      row.value.subject !== "desktop-local" ||
      !AuthStandardClientScopes.every((scope) => row.value.scopes.includes(scope))
    )
      return;
    yield* sessions
      .verify(saved.token)
      .pipe(Effect.catchTags({ SessionTokenExpiredError: () => Effect.void }));
    const issued = yield* sessions.issue({
      subject: "desktop-local",
      method: "bearer-access-token",
      scopes: AuthStandardClientScopes,
      client: { label: "T3 Code Desktop", deviceType: "desktop" },
      ttl: Duration.days(30),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const staging = yield* fs.makeTempDirectoryScoped({
          directory: config.stateDir,
          prefix: ".desktop-session-",
        });
        const staged = path.join(staging, DESKTOP_LOCAL_SESSION_FILE);
        yield* fs.writeFileString(
          staged,
          yield* encodeSession({
            sessionId: issued.sessionId,
            token: issued.token,
            expiresAt: DateTime.formatIso(issued.expiresAt),
          }),
          { mode: 0o600 },
        );
        yield* fs.rename(staged, sessionPath);
      }),
    ).pipe(Effect.tapError(() => sessions.revoke(issued.sessionId).pipe(Effect.ignore)));
    // Existing connections keep their bounded token until its natural expiry.
  }).pipe(
    Effect.mapError((cause) => new DesktopLocalSessionRenewalError({ cause })),
    Effect.withSpan("DesktopLocalSession.renew"),
  );

  return DesktopLocalSession.of({ renew });
});

export const layer = Layer.effect(DesktopLocalSession, make);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* DesktopLocalSession;
    const renew = service.renew.pipe(
      Effect.catch(() =>
        Effect.logWarning(
          "Could not renew Desktop's saved local session; repair its local provisioning.",
        ),
      ),
    );
    // A trial must not replace the credential before its database can no longer roll back.
    yield* ServerActivation.forkParked(
      Effect.gen(function* () {
        yield* renew;
        return yield* Effect.sleep(Duration.days(1)).pipe(Effect.andThen(renew), Effect.forever);
      }),
    );
  }),
).pipe(Layer.provide(layer));
