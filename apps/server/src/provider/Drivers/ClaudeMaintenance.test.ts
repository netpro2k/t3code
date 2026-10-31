import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  invalidateLatestProviderVersion,
  PackageManagerReleaseAge,
  resolveLatestProviderVersion,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { makeClaudeMaintenanceResolution } from "./ClaudeMaintenance.ts";

const nativeRoot = "https://downloads.claude.ai/claude-code-releases";

describe("Claude native maintenance", () => {
  it.live(
    "uses the native channel instead of a newer npm release and separates configured homes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const bin = path.join(directory, ".local/bin");
        yield* fs.makeDirectory(bin, { recursive: true });
        const binaryPath = path.join(bin, "claude");
        yield* fs.writeFileString(
          binaryPath,
          `#!/bin/sh
if [ "$1" != doctor ]; then exit 1; fi
/bin/cat "$CLAUDE_CONFIG_DIR/diagnostics"
exit "\${DOCTOR_EXIT_CODE:-0}"
`,
        );
        yield* fs.chmod(binaryPath, 0o755);
        for (const [channel, version] of [
          ["latest", "2.1.314"],
          ["stable", "2.1.308"],
        ] as const) {
          const configDir = path.join(directory, channel);
          yield* fs.makeDirectory(configDir);
          yield* fs.writeFileString(
            path.join(configDir, "diagnostics"),
            `Auto-update channel: ${channel}\n`,
          );
          const capabilities = yield* makeClaudeMaintenanceResolution({
            binaryPath,
            env: { CLAUDE_CONFIG_DIR: configDir },
          }).pipe(Effect.flatMap((resolve) => resolve()));
          expect(yield* resolveLatestProviderVersion(capabilities)).toBe(version);
          expect(
            yield* resolveLatestProviderVersion(capabilities, {
              respectPackageManagerReleaseAge: false,
            }),
          ).toBe(version);
          expect(capabilities.update?.env?.CLAUDE_CONFIG_DIR).toBe(configDir);
        }
        const latestHome = path.join(directory, "latest");
        yield* fs.writeFileString(
          path.join(latestHome, "diagnostics"),
          "Auto-update channel: stable\n",
        );
        const refreshed = yield* makeClaudeMaintenanceResolution({
          binaryPath,
          env: { CLAUDE_CONFIG_DIR: latestHome },
        }).pipe(Effect.flatMap((resolve) => resolve()));
        yield* invalidateLatestProviderVersion(refreshed);
        expect(yield* resolveLatestProviderVersion(refreshed)).toBe("2.1.308");
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(NodeServices.layer, ProviderLatestVersions.layer)),
        Effect.provideService(PackageManagerReleaseAge, {
          getCutoffMs: () => Effect.succeed(null),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const body =
              request.url === `${nativeRoot}/latest`
                ? "2.1.314"
                : request.url === `${nativeRoot}/stable`
                  ? "2.1.308"
                  : JSON.stringify({ version: "2.1.316" });
            return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
          }),
        ),
      ),
  );
  it.live("leaves native availability unknown when diagnostics or the feed cannot be trusted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const bin = path.join(directory, ".local/bin");
      yield* fs.makeDirectory(bin, { recursive: true });
      const binaryPath = path.join(bin, "claude");
      yield* fs.writeFileString(
        binaryPath,
        `#!/bin/sh
if [ "$1" != doctor ]; then exit 1; fi
/bin/cat "$CLAUDE_CONFIG_DIR/diagnostics"
exit "\${DOCTOR_EXIT_CODE:-0}"
`,
      );
      yield* fs.chmod(binaryPath, 0o755);
      const fixtures = [
        {
          name: "unknown-channel",
          diagnostics: "Auto-update channel: canary",
          code: "0",
          status: 200,
          body: "2.1.316",
          requests: 0,
        },
        {
          name: "missing-channel",
          diagnostics: "Old doctor output",
          code: "0",
          status: 200,
          body: "2.1.316",
          requests: 0,
        },
        {
          name: "failed-doctor",
          diagnostics: "Auto-update channel: latest",
          code: "1",
          status: 200,
          body: "2.1.316",
          requests: 0,
        },
        {
          name: "unavailable-feed",
          diagnostics: "Auto-update channel: latest",
          code: "0",
          status: 503,
          body: "Unavailable",
          requests: 1,
        },
        {
          name: "invalid-version",
          diagnostics: "Auto-update channel: latest",
          code: "0",
          status: 200,
          body: "<html>2.1.316</html>",
          requests: 1,
        },
      ];
      for (const fixture of fixtures) {
        const configDir = path.join(directory, fixture.name);
        yield* fs.makeDirectory(configDir);
        yield* fs.writeFileString(path.join(configDir, "diagnostics"), fixture.diagnostics);
        const requested: string[] = [];
        const capabilities = yield* makeClaudeMaintenanceResolution({
          binaryPath,
          env: { CLAUDE_CONFIG_DIR: configDir, DOCTOR_EXIT_CODE: fixture.code },
        }).pipe(
          Effect.flatMap((resolve) => resolve()),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              requested.push(request.url);
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(fixture.body, { status: fixture.status }),
                ),
              );
            }),
          ),
        );
        expect(yield* resolveLatestProviderVersion(capabilities)).toBeNull();
        expect(requested).toEqual(
          Array.from({ length: fixture.requests }, () => `${nativeRoot}/latest`),
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, ProviderLatestVersions.layer)),
      Effect.provideService(PackageManagerReleaseAge, { getCutoffMs: () => Effect.succeed(null) }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Native lookup must not fall back to npm")),
      ),
    ),
  );
});
