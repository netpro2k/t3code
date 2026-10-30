import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly managed?: boolean;
  readonly platform?: "linux" | "darwin";
  readonly arch?: "x64" | "arm64";
  readonly cached?: boolean;
  readonly preflight?: "ready" | "blocked";
  readonly preflightDuration?: Duration.Input;
  readonly preflightStarted?: Deferred.Deferred<void>;
  readonly beforeDownload?: Effect.Effect<void>;
  readonly httpClient?: HttpClient.HttpClient;
  readonly publication?:
    | "draft"
    | "missing"
    | "wrong-tag"
    | "no-checksums"
    | "wrong-platform"
    | "malformed"
    | "offline";
  readonly requestUpdate?: ServiceLauncherClient.ServiceLauncherClient["Service"]["requestUpdate"];
  readonly desktopAppUpdate?: DesktopAppUpdate.DesktopAppUpdate["Service"];
  readonly policy?: ManagedPolicyDocument;
}

const archiveBytes = new TextEncoder().encode("not really a tarball");
const releaseHttpClient = (order: string[], urls: string[], options: HarnessOptions) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      urls.push(request.url);
      const { publication } = options;
      const archiveName = `t3-1.1.0-netpro2k-${options.platform ?? "linux"}-${options.arch ?? "x64"}.tar.gz`;
      expect(request.url).toContain("netpro2k/t3code/");
      if (request.url.includes("/releases/tags/")) {
        order.push("publication");
        if (publication === "offline")
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
        if (publication === "missing")
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }));
        if (publication === "malformed")
          return HttpClientResponse.fromWeb(request, Response.json({}));
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            tag_name: publication === "wrong-tag" ? "v1.1.0" : "v1.1.0-netpro2k",
            draft: publication === "draft",
            assets: [
              ...(publication === "no-checksums" ? [] : [{ name: "SHA256SUMS" }]),
              {
                name:
                  publication === "wrong-platform"
                    ? "t3-1.1.0-netpro2k-darwin-arm64.tar.gz"
                    : archiveName,
              },
            ],
          }),
        );
      }
      if (request.url.endsWith("/SHA256SUMS")) {
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", archiveBytes));
        const hex = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        return HttpClientResponse.fromWeb(request, new Response(`${hex}  ${archiveName}\n`));
      }
      if (options.beforeDownload) yield* options.beforeDownload;
      order.push("download");
      return HttpClientResponse.fromWeb(request, new Response(archiveBytes));
    }),
  );

const makeHarness = Effect.fn("test.make_self_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-test-" });
  const order: string[] = [];
  const urls: string[] = [];
  if (options.cached) {
    const versionDir = path.join(baseDir, "runtime", "versions", "1.1.0-netpro2k");
    yield* fs.makeDirectory(versionDir, { recursive: true });
    yield* fs.writeFileString(path.join(versionDir, "t3"), "cached executable");
    yield* fs.writeFileString(path.join(versionDir, ".install-complete"), "1.1.0-netpro2k\n");
  }
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.command === "tar") {
          order.push("extract");
          const stagingDir = input.args[input.args.indexOf("-C") + 1];
          if (stagingDir === undefined) return yield* Effect.die("missing tar target");
          yield* fs.writeFileString(path.join(stagingDir, "t3"), "#!/bin/sh\n").pipe(Effect.orDie);
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }
        if (options.preflightStarted) yield* Deferred.succeed(options.preflightStarted, undefined);
        if (options.preflightDuration !== undefined) {
          // Like the real runner, fail once the caller's timeout elapses.
          const timeout = Duration.fromInputUnsafe(input.timeout ?? "60 seconds");
          const finished = yield* Effect.sleep(options.preflightDuration).pipe(
            Effect.timeoutOption(timeout),
          );
          if (finished._tag === "None") {
            return yield* new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: Duration.toMillis(timeout),
            });
          }
        }
        order.push("preflight");
        const result =
          options.preflight === "blocked"
            ? { status: "blocked", version: "1.1.0-netpro2k", reason: "local update required" }
            : {
                status: "ready",
                version: "1.1.0-netpro2k",
                launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
              };
        return {
          stdout: JSON.stringify(result),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const launcher = ServiceLauncherClient.ServiceLauncherClient.of({
    managed: options.managed ?? true,
    requestUpdate:
      options.requestUpdate ??
      (() =>
        Effect.sync(() => {
          order.push("accept");
          return "launcher-id";
        })),
    prepareTrial: Effect.undefined,
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const selfUpdate = yield* ServerSelfUpdate.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, launcher),
    Effect.provideService(
      DesktopAppUpdate.DesktopAppUpdate,
      options.desktopAppUpdate ?? {
        available: false,
        run: () => Effect.die("unexpected desktop app update run"),
      },
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      options.httpClient ?? releaseHttpClient(order, urls, options),
    ),
    Effect.provideService(HostProcess.Platform, options.platform ?? "linux"),
    Effect.provideService(HostProcess.Architecture, options.arch ?? "x64"),
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layer({ ...config, mode: options.mode ?? "web" }),
        ManagedPolicy.layerTest(options.policy),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              T3CODE_RELEASE_BASE_URL: "https://github.com/pingdotgg/t3code/releases/download",
            },
          }),
        ),
      ),
    ),
  );
  return { selfUpdate, order, urls, baseDir };
});

it.layer(NodeServices.layer)("server self update", (it) => {
  it.effect.each([
    { asset: "checksums", status: 504 },
    { asset: "archive", status: 503 },
    { asset: "checksums", status: 403 },
  ])("reports an HTTP $status downloading $asset and allows retry", ({ asset, status }) =>
    Effect.gen(function* () {
      let failDownload = true;
      const { selfUpdate, order, baseDir } = yield* makeHarness({
        httpClient: releaseHttpClient([], [], {}).pipe(
          HttpClient.transform((response, request) =>
            failDownload &&
            !request.url.includes("/releases/tags/") &&
            request.url.endsWith("/SHA256SUMS") === (asset === "checksums")
              ? Effect.succeed(
                  HttpClientResponse.fromWeb(
                    HttpClientRequest.get("https://user:password@cdn.example/private?token=secret"),
                    new Response("private response body", { status }),
                  ),
                )
              : response,
          ),
        ),
      });
      const error = yield* selfUpdate.update({ targetVersion: "1.1.0-netpro2k" }).pipe(Effect.flip);
      expect(error.reason).toBe(
        `Could not prepare t3@1.1.0-netpro2k while downloading the t3 release ${asset} (HTTP ${status} from cdn.example).`,
      );
      expect(order).toEqual([]);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions"))).toEqual([]);
      failDownload = false;
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0-netpro2k" })).updateId).toBe(
        "launcher-id",
      );
      expect(order).toEqual(["extract", "preflight", "accept"]);
    }),
  );

  // regression: #5181 make remote updates rollback-safe
  it.effect("rejects invalid versions and desktop-managed servers before staging", () =>
    Effect.gen(function* () {
      const web = yield* makeHarness();
      expect(
        (yield* web.selfUpdate.update({ targetVersion: "latest" }).pipe(Effect.flip)).reason,
      ).toBe("'latest' is not an exact t3 version.");
      const desktop = yield* makeHarness({ mode: "desktop" });
      expect(
        (yield* desktop.selfUpdate.update({ targetVersion: "1.1.0-netpro2k" }).pipe(Effect.flip))
          .reason,
      ).toContain("desktop app");
      expect([...web.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("refuses every update when the managed policy turns updates off", () =>
    Effect.gen(function* () {
      const policy: ManagedPolicyDocument = {
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { updates: { mode: "off" } },
      };
      const service = yield* makeHarness({ policy });
      const desktop = yield* makeHarness({
        mode: "desktop",
        policy,
        desktopAppUpdate: {
          available: true,
          run: () => Effect.die("unexpected desktop app update run"),
          commit: () => Effect.never,
        },
      });
      for (const harness of [service, desktop]) {
        expect(
          (yield* harness.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
        ).toBe("Example Corp manages T3 Code updates.");
      }
      expect([...service.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("lets a user start an update, but only to stable without nightly", () =>
    Effect.gen(function* () {
      const { selfUpdate, order, urls } = yield* makeHarness({
        policy: {
          schemaVersion: 1,
          organization: "Example Corp",
          limits: {
            updates: {
              mode: "auto",
              allowNightly: false,
              feedUrl: "https://updates.example.com/t3code/",
            },
          },
        },
      });
      expect(
        (yield* selfUpdate.update({ targetVersion: "1.2.0-nightly.20261028.1" }).pipe(Effect.flip))
          .reason,
      ).toBe("Example Corp manages T3 Code updates. Only stable releases can be installed.");
      expect(order).toEqual([]);
      expect(
        (yield* selfUpdate.update({ targetVersion: "1.2.0" }).pipe(Effect.flip)).reason,
      ).toContain("Only published netpro2k/t3code fork versions");
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0-netpro2k" })).updateId).toBe(
        "launcher-id",
      );
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url).toContain("netpro2k/t3code/");
    }),
  );

  it.effect("delegates desktop-managed updates to the desktop app when available", () =>
    Effect.gen(function* () {
      const stages: string[] = [];
      const { selfUpdate, order } = yield* makeHarness({
        mode: "desktop",
        desktopAppUpdate: {
          available: true,
          run: (reportProgress) =>
            reportProgress("downloading").pipe(
              Effect.andThen(reportProgress("installing")),
              Effect.as({ targetVersion: "1.2.0", method: "desktop-app" as const }),
            ),
          commit: () => Effect.never,
        },
      });
      const result = yield* selfUpdate.update({ targetVersion: "1.1.0-netpro2k" }, (stage) =>
        Effect.sync(() => void stages.push(stage)),
      );
      expect(result).toEqual({ targetVersion: "1.2.0", method: "desktop-app" });
      expect(stages).toEqual(["downloading", "installing"]);
      expect(order).toEqual([]);
    }),
  );

  it.effect("refuses an official mobile client's upstream version before any staging", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness();
      const error = yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip);
      expect(error.reason).toContain("Only published netpro2k/t3code fork versions");
      expect(order).toEqual([]);
      // A rejected request must not retain the in-flight lock.
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0-netpro2k" })).method).toBe(
        "boot-service",
      );
    }),
  );

  it.effect.each([
    "draft",
    "missing",
    "wrong-tag",
    "no-checksums",
    "wrong-platform",
    "malformed",
    "offline",
  ] as const)("refuses %s releases before downloading or handing off", (publication) =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness({ publication });
      yield* selfUpdate.update({ targetVersion: "1.1.0-netpro2k" }).pipe(Effect.flip);
      expect(order).toEqual(["publication"]);
    }),
  );

  it.effect("refuses an unpublished fork version even when a runtime is cached", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness({ cached: true, publication: "missing" });
      yield* selfUpdate.update({ targetVersion: "1.1.0-netpro2k" }).pipe(Effect.flip);
      expect(order).toEqual(["publication"]);
    }),
  );

  it.effect.each([
    { platform: "darwin", arch: "arm64" },
    { platform: "linux", arch: "arm64" },
  ] as const)("installs the published $platform-$arch fork archive", ({ platform, arch }) =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness({ platform, arch });
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0-netpro2k" })).method).toBe(
        "boot-service",
      );
      expect(order).toEqual(["publication", "download", "extract", "preflight", "accept"]);
    }),
  );

  it.effect("preserves the preflight refusal reason", () =>
    Effect.gen(function* () {
      const { selfUpdate } = yield* makeHarness({ preflight: "blocked" });
      expect(
        (yield* selfUpdate.update({ targetVersion: "1.1.0-netpro2k" }).pipe(Effect.flip)).reason,
      ).toBe("local update required");
    }),
  );

  it.effect("allows only one update at a time", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<string>();
      const { selfUpdate } = yield* makeHarness({
        requestUpdate: () =>
          Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      });
      const first = yield* Effect.forkChild(
        selfUpdate.update({ targetVersion: "1.1.0-netpro2k" }),
        {
          startImmediately: true,
        },
      );
      yield* Deferred.await(requested);
      expect(
        (yield* selfUpdate.update({ targetVersion: "1.1.1-netpro2k.1" }).pipe(Effect.flip)).reason,
      ).toBe("A server update is already in progress.");
      yield* Deferred.succeed(accepted, "launcher-id");
      expect((yield* Fiber.join(first)).updateId).toBe("launcher-id");
    }),
  );

  // regression: #28198 a slow staged preflight on a loaded host no longer fails the update
  it.effect("waits for a staged preflight that takes a minute on a loaded host", () =>
    Effect.gen(function* () {
      const preflightStarted = yield* Deferred.make<void>();
      const { selfUpdate, order } = yield* makeHarness({
        preflightDuration: "60 seconds",
        preflightStarted,
      });
      const update = yield* Effect.forkChild(
        selfUpdate.update({ targetVersion: "1.1.0-netpro2k" }),
        {
          startImmediately: true,
        },
      );
      yield* Deferred.await(preflightStarted);
      yield* TestClock.adjust("60 seconds");
      const exit = yield* Fiber.await(update);
      expect(exit._tag === "Failure" ? String(exit.cause) : "launcher handoff").toBe(
        "launcher handoff",
      );
      expect(order).toEqual(["publication", "download", "extract", "preflight", "accept"]);
    }),
  );

  it.effect("keeps preparing after the progress stream closes", () =>
    Effect.gen(function* () {
      const releaseDownload = yield* Deferred.make<void>();
      const sawDownloading = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<void>();
      const { selfUpdate, order } = yield* makeHarness({
        beforeDownload: Deferred.await(releaseDownload),
        requestUpdate: () =>
          Effect.sync(() => {
            order.push("accept");
          }).pipe(Effect.andThen(Deferred.succeed(accepted, undefined)), Effect.as("launcher-id")),
      });

      const consumed = yield* ServerSelfUpdate.updateProgressStream(selfUpdate, {
        targetVersion: "1.1.0-netpro2k",
      }).pipe(
        Stream.tap((event) =>
          event.type === "progress" && event.stage === "downloading"
            ? Deferred.succeed(sawDownloading, undefined)
            : Effect.void,
        ),
        Stream.runDrain,
        Effect.forkChild,
      );

      yield* Deferred.await(sawDownloading);
      yield* Fiber.interrupt(consumed);
      expect((yield* selfUpdate.update({ targetVersion: "1.2.0" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );

      yield* Deferred.succeed(releaseDownload, undefined);
      yield* Deferred.await(accepted);
      expect(order).toEqual(["publication", "download", "extract", "preflight", "accept"]);
      expect(
        (yield* selfUpdate.update({ targetVersion: "1.1.0-netpro2k" }).pipe(Effect.flip)).reason,
      ).toBe("A server update is already in progress.");
    }),
  );
});

it.layer(NodeServices.layer)("pruning runtimes on start", (it) => {
  const staleVersion = "0.0.1";
  const otherProcesses = ProcessRunner.ProcessRunner.of({
    run: () =>
      Effect.succeed({
        stdout: "p42\nftxt\nn/bin/sh\n",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });

  const pruneOnStart = Effect.fn("test.prune_on_start")(function* (input: {
    readonly executable: "own runtime" | "elsewhere";
    readonly managed?: boolean;
    readonly symlinkedHome?: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-prune-on-start-" });
    const realHome = path.join(tempDir, "home");
    const baseDir = input.symlinkedHome ? path.join(tempDir, "linked-home") : realHome;
    const versionsDir = path.join(baseDir, "runtime", "versions");
    yield* TestClock.setTime(24 * 60 * 60 * 1000);
    for (const version of [staleVersion, packageJson.version]) {
      const directory = path.join(realHome, "runtime", "versions", version);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "t3"), "");
      const sentinel = path.join(directory, ".install-complete");
      yield* fs.writeFileString(sentinel, `${version}\n`);
      yield* fs.utimes(sentinel, 0, 0);
    }
    if (input.symlinkedHome) yield* fs.symlink(realHome, baseDir);
    // Like `process.execPath`, the running runtime is reported by its real path.
    const executablePath =
      input.executable === "own runtime"
        ? yield* fs.realPath(path.join(versionsDir, packageJson.version, "t3"))
        : "/usr/local/bin/node";
    const removed = yield* ServerSelfUpdate.pruneRuntimesOnStart({
      baseDir,
      managed: input.managed ?? false,
    }).pipe(
      Effect.provideService(HostProcess.ExecutablePath, executablePath),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(ProcessRunner.ProcessRunner, otherProcesses),
    );
    return { removed, remaining: (yield* fs.readDirectory(versionsDir)).toSorted() };
  });

  // The SSH launcher runs `t3 serve` straight from the pinned runtime, with no boot service.
  it.effect("prunes for a server started from its home's pinned runtime", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({ executable: "own runtime" });
      expect(removed).toEqual([staleVersion]);
      expect(remaining).toEqual([packageJson.version]);
    }),
  );

  it.effect("recognizes its runtime through a symlinked T3 home", () =>
    Effect.gen(function* () {
      const { removed } = yield* pruneOnStart({ executable: "own runtime", symlinkedHome: true });
      expect(removed).toEqual([staleVersion]);
    }),
  );

  it.effect("prunes for a boot-service server wherever it runs from", () =>
    Effect.gen(function* () {
      const { removed } = yield* pruneOnStart({ executable: "elsewhere", managed: true });
      expect(removed).toEqual([staleVersion]);
    }),
  );

  it.effect("leaves runtimes alone for an unmanaged server started elsewhere", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({ executable: "elsewhere" });
      expect(removed).toEqual([]);
      expect(remaining).toEqual([staleVersion, packageJson.version].toSorted());
    }),
  );
});

it("a host crosses tracks only to a release that knows its whole database", () => {
  const cross = (
    serverVersion: string,
    targetVersion: string,
    targetDatabaseMigration: number | undefined,
    databaseMigration = 72,
  ) =>
    ServerSelfUpdate.trackSwitchBlockReason({
      serverVersion,
      targetVersion,
      targetDatabaseMigration,
      databaseMigration: () => databaseMigration,
    });
  const nightly = "0.1.4-nightly.20261027.3796";

  expect(cross(nightly, "0.1.4", 72)).toBeNull();
  // Another client moved this host to a newer Nightly after the switch was planned.
  expect(cross(nightly, "0.1.4", 72, 73)).toContain("does not support yet");
  expect(cross(nightly, "0.1.4", undefined)).toContain("Cannot confirm");
  // A Stable tag can carry a migration the latest Nightly lacks.
  expect(cross("0.1.4", nightly, 72, 73)).toContain("does not support yet");
  expect(cross("0.1.3", "0.1.4", undefined)).toBeNull();
  // A database that exists but cannot be read proves nothing.
  expect(
    ServerSelfUpdate.trackSwitchBlockReason({
      serverVersion: nightly,
      targetVersion: "0.1.4",
      targetDatabaseMigration: 72,
      databaseMigration: () => undefined,
    }),
  ).toContain("Cannot confirm");
});
