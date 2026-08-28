// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import {
  discoverExistingLocalBackend,
  isProcessAlive,
  requiresExistingLocalBackend,
} from "./DesktopExistingLocalBackend.ts";

describe("requiresExistingLocalBackend", () => {
  it("requires the background service for packaged macOS and Linux launches", () => {
    assert.isTrue(
      requiresExistingLocalBackend({
        isDevelopment: false,
        platform: "darwin",
      }),
    );
    assert.isTrue(
      requiresExistingLocalBackend({
        isDevelopment: false,
        platform: "linux",
      }),
    );
  });

  it("keeps development and Windows on their native backend lifecycle", () => {
    assert.isFalse(
      requiresExistingLocalBackend({
        isDevelopment: true,
        platform: "darwin",
      }),
    );
    assert.isFalse(
      requiresExistingLocalBackend({
        isDevelopment: false,
        platform: "win32",
      }),
    );
  });
});

const RuntimeStateJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    pid: Schema.Int,
    port: Schema.Int,
    origin: Schema.String,
    startedAt: Schema.String,
    desktopAttachToken: Schema.optionalKey(Schema.String),
  }),
);
const encodeRuntimeStateJson = Schema.encodeEffect(RuntimeStateJson);
const discoverTestLayer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

describe("isProcessAlive", () => {
  it("reports the current process as alive", () => {
    assert.isTrue(isProcessAlive(process.pid));
  });

  it("reports an unused pid as dead", () => {
    assert.isFalse(isProcessAlive(1_000_000_007));
  });
});

const testDescriptor = {
  environmentId: "attach-test-environment",
  label: "attach-test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.1",
  capabilities: { repositoryIdentity: true },
};

const withDescriptorServer = <A, E, R>(run: (origin: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/.well-known/t3/environment") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(testDescriptor));
          return;
        }
        response.writeHead(404);
        response.end();
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return Effect.die(new Error("Expected a TCP address"));
      }
      return run(`http://127.0.0.1:${String(address.port)}`);
    },
    (server) => Effect.sync(() => server.close()),
  );

describe("discoverExistingLocalBackend", () => {
  it.effect("returns none when no runtime state file exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-existing-backend-test-",
      });
      const discovered = yield* discoverExistingLocalBackend(
        path.join(root, "missing-server-runtime.json"),
      );
      assert.isTrue(Option.isNone(discovered));
    }).pipe(Effect.provide(discoverTestLayer)),
  );

  it.effect("skips a runtime file whose pid is dead", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-existing-backend-test-",
      });
      const statePath = path.join(root, "server-runtime.json");
      const encoded = yield* encodeRuntimeStateJson({
        version: 1,
        pid: 1_000_000_007,
        port: 3773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-08-27T00:00:00.000Z",
      });
      yield* fileSystem.writeFileString(statePath, `${encoded}\n`);
      const discovered = yield* discoverExistingLocalBackend(statePath);
      assert.isTrue(Option.isNone(discovered));
    }).pipe(Effect.provide(discoverTestLayer)),
  );

  it.effect("returns an attachable backend for a live pid with an attach token", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-existing-backend-test-",
        });
        const statePath = path.join(root, "server-runtime.json");
        const port = Number(new URL(origin).port);
        const encoded = yield* encodeRuntimeStateJson({
          version: 1,
          pid: process.pid,
          port,
          origin,
          desktopAttachToken: "attach-token",
          startedAt: "2026-08-27T00:00:00.000Z",
        });
        yield* fileSystem.writeFileString(statePath, `${encoded}\n`);
        const discovered = yield* discoverExistingLocalBackend(statePath);
        assert.deepEqual(Option.getOrThrow(discovered), {
          origin,
          port,
          pid: process.pid,
          desktopAttachToken: "attach-token",
        });
      }).pipe(Effect.provide(discoverTestLayer)),
    ),
  );

  it.effect("returns a backend without a token so callers can fail closed", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-existing-backend-test-",
        });
        const statePath = path.join(root, "server-runtime.json");
        const port = Number(new URL(origin).port);
        const encoded = yield* encodeRuntimeStateJson({
          version: 1,
          pid: process.pid,
          port,
          origin,
          startedAt: "2026-08-27T00:00:00.000Z",
        });
        yield* fileSystem.writeFileString(statePath, `${encoded}\n`);
        const discovered = yield* discoverExistingLocalBackend(statePath);
        assert.deepEqual(Option.getOrThrow(discovered), {
          origin,
          port,
          pid: process.pid,
          desktopAttachToken: null,
        });
      }).pipe(Effect.provide(discoverTestLayer)),
    ),
  );
});
