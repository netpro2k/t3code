import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthStandardClientScopes, EnvironmentId } from "@t3tools/contracts";
import { DesktopLocalSessionJson } from "@t3tools/shared/desktopLocalSession";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as DesktopLocalSession from "./DesktopLocalSession.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

it.layer(Layer.merge(NodeServices.layer, NodeCrypto.layer))("DesktopLocalSession", (it) => {
  it.effect.each([
    "fresh",
    "due",
    "expired",
    "revoked",
    "missing",
    "malformed",
    "limited",
    "standby",
  ] as const)("renews only eligible provisioned sessions: %s", (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const renewed = yield* Deferred.make<void>();
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-session-" });
      const sessionPath = path.join(stateDir, "desktop-session.json");
      const layerConfig = Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return { ...config, stateDir };
        }),
      ).pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-local-session-config-" }),
        ),
      );
      const layerSessions = SessionStore.layer.pipe(
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("local-session-test")),
          }),
        ),
        Layer.provide(layerConfig),
      );
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const local = yield* DesktopLocalSession.DesktopLocalSession;
        const issued = yield* sessions.issue({
          subject: "desktop-local",
          method: "bearer-access-token",
          ttl: Duration.days(30),
          scopes: scenario === "limited" ? ["orchestration:read"] : AuthStandardClientScopes,
        });
        const saved = {
          sessionId: issued.sessionId,
          token: issued.token,
          expiresAt: DateTime.formatIso(issued.expiresAt),
        };
        const encode = Schema.encodeEffect(DesktopLocalSessionJson);
        const decode = Schema.decodeEffect(DesktopLocalSessionJson);
        if (scenario !== "missing")
          yield* fs.writeFileString(
            sessionPath,
            scenario === "malformed" ? "{" : yield* encode(saved),
            { mode: 0o600 },
          );
        if (scenario === "revoked") yield* sessions.revoke(issued.sessionId);
        yield* TestClock.adjust(
          Duration.days(scenario === "fresh" ? 1 : scenario === "expired" ? 31 : 24),
        );
        if (scenario === "malformed") {
          assert.isTrue(yield* local.renew.pipe(Effect.flip, Effect.isSuccess));
          assert.equal(yield* fs.readFileString(sessionPath), "{");
          return;
        }
        if (scenario === "standby") {
          const activation = yield* Deferred.make<void>();
          yield* Effect.gen(function* () {
            assert.deepEqual(yield* decode(yield* fs.readFileString(sessionPath)), saved);
            yield* Deferred.succeed(activation, undefined);
            yield* Deferred.await(renewed);
            assert.notEqual(
              (yield* decode(yield* fs.readFileString(sessionPath))).sessionId,
              saved.sessionId,
            );
          }).pipe(
            Effect.provide(DesktopLocalSession.layerWorker.pipe(Layer.provide(layerConfig))),
            Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
          );
          return;
        }
        yield* local.renew;
        if (scenario === "missing") {
          assert.isFalse(yield* fs.exists(sessionPath));
          return;
        }
        const current = yield* decode(yield* fs.readFileString(sessionPath));
        if (scenario !== "due" && scenario !== "expired") {
          assert.deepEqual(current, saved);
          return;
        }
        assert.notEqual(current.sessionId, saved.sessionId);
        const verified = yield* sessions.verify(current.token);
        assert.deepEqual(verified.scopes, AuthStandardClientScopes);
        assert.equal(verified.subject, "desktop-local");
        assert.equal((yield* fs.stat(sessionPath)).mode & 0o777, 0o600);
        assert.equal(
          Date.parse(current.expiresAt),
          DateTime.toEpochMillis(yield* DateTime.now) + Duration.toMillis(Duration.days(30)),
        );
        // Rotation does not disconnect a Desktop still using its unexpired token.
        if (scenario === "due")
          assert.equal((yield* sessions.verify(saved.token)).sessionId, saved.sessionId);
        yield* local.renew;
        assert.deepEqual(yield* decode(yield* fs.readFileString(sessionPath)), current);
      }).pipe(
        Effect.provide(
          DesktopLocalSession.layer.pipe(
            Layer.provideMerge(layerSessions),
            Layer.provide(layerConfig),
          ),
        ),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            fs.rename(from, to).pipe(Effect.tap(() => Deferred.succeed(renewed, undefined))),
        }),
      );
    }),
  );
});
