import { fetchRemoteSessionState } from "@t3tools/client-runtime/authorization";
import { AuthAdministrativeScopes } from "@t3tools/contracts";
import { DesktopLocalSessionJson } from "@t3tools/shared/desktopLocalSession";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const readAttachedSessionToken = Effect.fn("desktop.readAttachedSessionToken")(
  function* (sessionPath: string, httpBaseUrl: string) {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(sessionPath);
    const session = yield* Schema.decodeUnknownEffect(DesktopLocalSessionJson)(raw);
    const expiresAt = DateTime.make(session.expiresAt);
    const now = yield* DateTime.now;
    if (Option.isNone(expiresAt) || DateTime.isLessThanOrEqualTo(expiresAt.value, now)) {
      return Option.none<string>();
    }
    const state = yield* fetchRemoteSessionState({
      httpBaseUrl,
      bearerToken: session.token,
      timeoutMs: 1_500,
    });
    return state.authenticated &&
      AuthAdministrativeScopes.every((scope) => state.scopes?.includes(scope))
      ? Option.some(session.token)
      : Option.none<string>();
  },
  Effect.orElseSucceed(() => Option.none<string>()),
);
