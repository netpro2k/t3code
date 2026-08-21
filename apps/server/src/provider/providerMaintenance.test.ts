// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  createProviderVersionAdvisory,
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  MiseOwnedToolCache,
  normalizeCommandPath,
  PackageManagerReleaseAge,
  parseManagedLatestVersion,
  parseNpmBeforeConfigValue,
  pickInstallableLatest,
  ProviderVersionCache,
  resolveLatestProviderVersion,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "./providerMaintenance.ts";

const driver = (value: string) => ProviderDriverKind.make(value);
const makeTempDir = (name: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.map((id) => NodePath.join(NodeOS.tmpdir(), `${name}-${id}`)),
  );
const isNativeTestCommandPath =
  (expectedPathSegment: string) =>
  (commandPath: string): boolean =>
    normalizeCommandPath(commandPath).includes(expectedPathSegment);
const packageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("packageTool"),
  npmPackageName: "@example/package-tool",
  homebrewFormula: "package-tool",
  nativeUpdate: null,
});
const nativePackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("nativePackageTool"),
  npmPackageName: "@example/native-package-tool",
  homebrewFormula: "native-package-tool",
  nativeUpdate: {
    executable: "native-package-tool",
    args: ["update"],
    lockKey: "native-package-tool-native",
    isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
  },
});
const scopedPackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("scopedPackageTool"),
  npmPackageName: "@example/scoped-package-tool",
  homebrewFormula: "example/tap/scoped-package-tool",
  nativeUpdate: {
    executable: "scoped-package-tool",
    args: ["upgrade"],
    lockKey: "scoped-package-tool-native",
    isCommandPath: isNativeTestCommandPath("/.scoped-package-tool/bin/scoped-package-tool"),
  },
});
const staticToolUpdate = makeStaticProviderMaintenanceResolver(
  makeProviderMaintenanceCapabilities({
    provider: driver("staticTool"),
    packageName: null,
    updateExecutable: "static-tool",
    updateArgs: ["update"],
    updateLockKey: "static-tool",
  }),
);
const noPackageManagerReleaseAge = {
  getCutoffMs: () => Effect.succeed<number | null>(null),
};
const packageManagerReleaseAge = (beforeMs: number) => ({
  getCutoffMs: (input: { readonly lockKey: string }) =>
    Effect.succeed(
      input.lockKey === "npm-global" ||
        input.lockKey === "pnpm-global" ||
        input.lockKey === "bun-global"
        ? beforeMs
        : null,
    ),
});
const registryHttpClient = (handler: (url: string) => unknown) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json(handler(String(request.url)), {
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
const makeMiseMock = (
  rootDir: string,
  options: {
    readonly which: Record<string, string>;
    readonly latest: Record<string, string>;
    readonly ls: unknown;
  },
) => {
  const binDir = NodePath.join(rootDir, "mise-mock-bin");
  NodeFS.mkdirSync(binDir, { recursive: true });
  const whichCases = Object.entries(options.which).map(
    ([name, path]) => `    ${name}) echo '${path}'; exit 0;;`,
  );
  const latestCases = Object.entries(options.latest).map(
    ([name, version]) => `    ${name}) echo '${version}'; exit 0;;`,
  );
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "which" ]; then',
    '  case "$2" in',
    ...whichCases,
    "    *) exit 1;;",
    "  esac",
    "fi",
    'if [ "$1" = "latest" ]; then',
    '  case "$2" in',
    ...latestCases,
    "    *) exit 1;;",
    "  esac",
    "fi",
    'if [ "$1" = "ls" ] && [ "$2" = "--json" ]; then',
    `  echo '${JSON.stringify(options.ls)}'; exit 0`,
    "fi",
    "exit 1",
  ].join("\n");
  NodeFS.writeFileSync(NodePath.join(binDir, "mise"), script);
  NodeFS.chmodSync(NodePath.join(binDir, "mise"), 0o755);
  return binDir;
};

it("parses npm before config values", () => {
  expect(parseNpmBeforeConfigValue("null")).toBeNull();
  expect(parseNpmBeforeConfigValue("")).toBeNull();
  expect(parseNpmBeforeConfigValue("2026-08-13T22:34:50.749Z")).toBe(
    Date.parse("2026-08-13T22:34:50.749Z"),
  );
});

it("parses managed latest version output", () => {
  expect(parseManagedLatestVersion("2.1.235\n")).toBe("2.1.235");
  expect(parseManagedLatestVersion("v2.1.235")).toBe("2.1.235");
  expect(parseManagedLatestVersion("")).toBeNull();
  expect(parseManagedLatestVersion(null)).toBeNull();
  expect(parseManagedLatestVersion("mise: error: tool not found")).toBeNull();
});

it("picks registry latest when there is no recency cutoff", () => {
  expect(
    pickInstallableLatest({
      distTagLatest: "2.0.0",
      times: { "1.0.0": "2026-01-01T00:00:00.000Z", "2.0.0": "2026-08-20T00:00:00.000Z" },
      beforeMs: null,
    }),
  ).toBe("2.0.0");
});

it("walks back from a too-new latest to the newest stable version at or before the cutoff", () => {
  expect(
    pickInstallableLatest({
      distTagLatest: "2.0.0",
      times: {
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-08-20T00:00:00.000Z",
        "1.0.0": "2026-07-01T00:00:00.000Z",
        "1.5.0": "2026-08-07T00:00:00.000Z",
        "1.5.0-darwin-arm64": "2026-08-07T00:00:00.000Z",
        "1.6.0-alpha.1": "2026-08-08T00:00:00.000Z",
        "2.0.0": "2026-08-20T00:00:00.000Z",
      },
      beforeMs: Date.parse("2026-08-13T00:00:00.000Z"),
    }),
  ).toBe("1.5.0");
});

it("keeps dist-tag latest when it is old enough, even if newer stables exist after the cutoff", () => {
  expect(
    pickInstallableLatest({
      distTagLatest: "1.4.0",
      times: {
        "1.4.0": "2026-08-01T00:00:00.000Z",
        "1.5.0": "2026-08-20T00:00:00.000Z",
      },
      beforeMs: Date.parse("2026-08-13T00:00:00.000Z"),
    }),
  ).toBe("1.4.0");
});

const installedPackageToolProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("packageTool"),
  driver: driver("packageTool"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

it.layer(NodeServices.layer)("providerMaintenance", (it) => {
  it.effect("reads cached versions through the injectable cache reference", () =>
    resolveLatestProviderVersion(packageToolUpdate.resolve()).pipe(
      Effect.provideService(
        ProviderVersionCache,
        new Map([
          [
            "@example/package-tool",
            {
              expiresAt: Number.MAX_SAFE_INTEGER,
              version: "9.9.9",
            },
          ],
        ]),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("cached provider version should not make an HTTP request"),
        ),
      ),
      Effect.provideService(PackageManagerReleaseAge, noPackageManagerReleaseAge),
      Effect.map((version) => {
        expect(version).toBe("9.9.9");
      }),
    ),
  );

  it.effect("does not fetch latest provider versions when update checks are disabled", () =>
    enrichProviderSnapshotWithVersionAdvisory(
      installedPackageToolProvider,
      packageToolUpdate.resolve(),
      {
        enableProviderUpdateChecks: false,
      },
    ).pipe(
      Effect.provideService(ProviderVersionCache, new Map()),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("disabled provider update checks should not make an HTTP request"),
        ),
      ),
      Effect.map((provider) => {
        expect(provider.versionAdvisory).toMatchObject({
          status: "unknown",
          currentVersion: "1.0.0",
          latestVersion: null,
          checkedAt: "2026-04-10T00:00:00.000Z",
        });
      }),
    ),
  );

  it("marks providers with unknown current versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: null,
        latestVersion: "9.9.9",
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: null,
      latestVersion: "9.9.9",
    });
  });

  it("marks providers with unknown latest versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "1.0.0",
        latestVersion: null,
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: "1.0.0",
      latestVersion: null,
      message: null,
    });
  });

  it("marks installed providers behind latest when a newer provider version is available", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("nativePackageTool"),
        currentVersion: "2.1.110",
        latestVersion: "2.1.117",
        maintenanceCapabilities: nativePackageToolUpdate.resolve(),
      }),
    ).toMatchObject({
      status: "behind_latest",
      currentVersion: "2.1.110",
      latestVersion: "2.1.117",
      updateCommand:
        "npm install -g --allow-scripts=@example/native-package-tool @example/native-package-tool@latest",
      canUpdate: true,
      message: "Install the update now or review provider settings.",
    });
  });

  it("keeps update commands owned by provider maintenance capabilities", () => {
    expect(staticToolUpdate.resolve()).toEqual({
      provider: driver("staticTool"),
      packageName: null,
      update: {
        command: "static-tool update",

        executable: "static-tool",

        args: ["update"],

        lockKey: "static-tool",
      },
    });
  });

  it.effect(
    "switches package-managed providers to vite-plus updates when the resolved binary lives in vite-plus global bin",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-vite-plus-capabilities");
        const vitePlusBinDir = NodePath.join(tempDir, ".vite-plus", "bin");
        NodeFS.mkdirSync(vitePlusBinDir, { recursive: true });
        const packageToolPath = NodePath.join(vitePlusBinDir, "package-tool");
        NodeFS.writeFileSync(packageToolPath, "#!/bin/sh\n");
        NodeFS.chmodSync(packageToolPath, 0o755);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          {
            binaryPath: "package-tool",
            env: {
              PATH: vitePlusBinDir,
            },
          },
        ).pipe(Effect.provideService(HostProcessPlatform, "darwin"));

        expect(capabilities).toEqual({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          update: {
            command: "vp i -g @example/package-tool",

            executable: "vp",

            args: ["i", "-g", "@example/package-tool"],

            lockKey: "vite-plus-global",
          },
        });
      }),
  );

  it.effect(
    "switches package-managed providers to bun updates when the resolved binary lives in bun's global bin",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-bun-capabilities");
        const bunBinDir = NodePath.join(tempDir, ".bun", "bin");
        NodeFS.mkdirSync(bunBinDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(bunBinDir, "native-package-tool.exe"), "MZ");

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          nativePackageToolUpdate,
          {
            binaryPath: "native-package-tool",
            env: {
              PATH: bunBinDir,
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
          },
        ).pipe(Effect.provideService(HostProcessPlatform, "win32"));

        expect(capabilities).toEqual({
          provider: driver("nativePackageTool"),
          packageName: "@example/native-package-tool",
          update: {
            command: "bun i -g @example/native-package-tool@latest",

            executable: "bun",

            args: ["i", "-g", "@example/native-package-tool@latest"],

            lockKey: "bun-global",
          },
        });
      }),
  );

  it.effect(
    "switches package-managed providers to pnpm updates when the resolved binary lives in pnpm's global bin",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-pnpm-capabilities");
        const pnpmHomeDir = NodePath.join(tempDir, ".local", "share", "pnpm");
        NodeFS.mkdirSync(pnpmHomeDir, { recursive: true });
        const scopedPackageToolPath = NodePath.join(pnpmHomeDir, "scoped-package-tool");
        NodeFS.writeFileSync(scopedPackageToolPath, "#!/bin/sh\n");
        NodeFS.chmodSync(scopedPackageToolPath, 0o755);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          scopedPackageToolUpdate,
          {
            binaryPath: "scoped-package-tool",
            env: {
              PATH: pnpmHomeDir,
            },
          },
        ).pipe(Effect.provideService(HostProcessPlatform, "darwin"));

        expect(capabilities).toEqual({
          provider: driver("scopedPackageTool"),
          packageName: "@example/scoped-package-tool",
          update: {
            command: "pnpm add -g @example/scoped-package-tool@latest",

            executable: "pnpm",

            args: ["add", "-g", "@example/scoped-package-tool@latest"],

            lockKey: "pnpm-global",
          },
        });
      }),
  );

  it("switches package-tool to Homebrew updates when the binary resolves through Homebrew", () => {
    expect(
      packageToolUpdate.resolve({
        binaryPath: "/opt/homebrew/bin/package-tool",
        env: {
          PATH: "",
        },
      }),
    ).toEqual({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      update: {
        command: "brew upgrade package-tool",

        executable: "brew",

        args: ["upgrade", "package-tool"],

        lockKey: "homebrew",
      },
    });
  });

  it.effect(
    "switches native-package-tool to native updates when the binary resolves through the native installer",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-native-package-tool-native-capabilities");
        const nativeBinDir = NodePath.join(tempDir, ".local", "bin");
        NodeFS.mkdirSync(nativeBinDir, { recursive: true });
        const nativePackageToolPath = NodePath.join(nativeBinDir, "native-package-tool");
        NodeFS.writeFileSync(nativePackageToolPath, "#!/bin/sh\n");
        NodeFS.chmodSync(nativePackageToolPath, 0o755);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          nativePackageToolUpdate,
          {
            binaryPath: "native-package-tool",
            env: {
              PATH: nativeBinDir,
            },
          },
        ).pipe(Effect.provideService(HostProcessPlatform, "darwin"));

        expect(capabilities).toEqual({
          provider: driver("nativePackageTool"),
          packageName: "@example/native-package-tool",
          update: {
            command: "native-package-tool update",

            executable: "native-package-tool",

            args: ["update"],

            lockKey: "native-package-tool-native",
          },
        });
      }),
  );

  it.effect(
    "switches scoped-package-tool to native upgrades when the binary resolves through the standalone installer",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-scoped-package-tool-native-capabilities");
        const nativeBinDir = NodePath.join(tempDir, ".scoped-package-tool", "bin");
        NodeFS.mkdirSync(nativeBinDir, { recursive: true });
        const scopedPackageToolPath = NodePath.join(nativeBinDir, "scoped-package-tool");
        NodeFS.writeFileSync(scopedPackageToolPath, "#!/bin/sh\n");
        NodeFS.chmodSync(scopedPackageToolPath, 0o755);

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          scopedPackageToolUpdate,
          {
            binaryPath: "scoped-package-tool",
            env: {
              PATH: nativeBinDir,
            },
          },
        ).pipe(Effect.provideService(HostProcessPlatform, "darwin"));

        expect(capabilities).toEqual({
          provider: driver("scopedPackageTool"),
          packageName: "@example/scoped-package-tool",
          update: {
            command: "scoped-package-tool upgrade",

            executable: "scoped-package-tool",

            args: ["upgrade"],

            lockKey: "scoped-package-tool-native",
          },
        });
      }),
  );

  it("switches native-package-tool to Homebrew updates when the binary resolves through Homebrew", () => {
    expect(
      nativePackageToolUpdate.resolve({
        binaryPath: "/opt/homebrew/bin/native-package-tool",
        env: {
          PATH: "",
        },
      }),
    ).toEqual({
      provider: driver("nativePackageTool"),
      packageName: "@example/native-package-tool",
      update: {
        command: "brew upgrade native-package-tool",

        executable: "brew",

        args: ["upgrade", "native-package-tool"],

        lockKey: "homebrew",
      },
    });
  });

  it("switches scoped-package-tool to Homebrew updates when the binary resolves through Homebrew", () => {
    expect(
      scopedPackageToolUpdate.resolve({
        binaryPath: "/opt/homebrew/bin/scoped-package-tool",
        env: {
          PATH: "",
        },
      }),
    ).toEqual({
      provider: driver("scopedPackageTool"),
      packageName: "@example/scoped-package-tool",
      update: {
        command: "brew upgrade example/tap/scoped-package-tool",

        executable: "brew",

        args: ["upgrade", "example/tap/scoped-package-tool"],

        lockKey: "homebrew",
      },
    });
  });

  it.effect("keeps npm updates for binaries symlinked into npm's global node_modules tree", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-npm-capabilities");
      const binDir = NodePath.join(tempDir, "bin");
      const packageBinDir = NodePath.join(
        tempDir,
        "lib",
        "node_modules",
        "@example",
        "package-tool",
        "bin",
      );
      NodeFS.mkdirSync(binDir, { recursive: true });
      NodeFS.mkdirSync(packageBinDir, { recursive: true });
      const packageBinPath = NodePath.join(packageBinDir, "package-tool.js");
      const symlinkPath = NodePath.join(binDir, "package-tool");
      NodeFS.writeFileSync(packageBinPath, "#!/usr/bin/env node\n");
      NodeFS.chmodSync(packageBinPath, 0o755);
      NodeFS.symlinkSync(packageBinPath, symlinkPath);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: symlinkPath,
        env: {
          PATH: "",
        },
      });

      expect(capabilities).toEqual({
        provider: driver("packageTool"),
        packageName: "@example/package-tool",
        update: {
          command:
            "npm install -g --allow-scripts=@example/package-tool @example/package-tool@latest",

          executable: "npm",

          args: [
            "install",
            "-g",
            "--allow-scripts=@example/package-tool",
            "@example/package-tool@latest",
          ],

          lockKey: "npm-global",
        },
      });
    }),
  );

  it.effect("switches package-managed providers to mise upgrades when mise owns the binary", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-mise-capabilities");
      const installsDir = NodePath.join(tempDir, ".local", "share", "mise", "installs");
      const packageToolBinDir = NodePath.join(installsDir, "package-tool", "2.1.241", "bin");
      NodeFS.mkdirSync(packageToolBinDir, { recursive: true });
      const realBinPath = NodePath.join(packageToolBinDir, "package-tool");
      NodeFS.writeFileSync(realBinPath, "#!/bin/sh\n");
      NodeFS.chmodSync(realBinPath, 0o755);
      const shimsDir = NodePath.join(tempDir, ".local", "share", "mise", "shims");
      NodeFS.mkdirSync(shimsDir, { recursive: true });
      NodeFS.symlinkSync(realBinPath, NodePath.join(shimsDir, "package-tool"));
      const miseMockBinDir = makeMiseMock(tempDir, {
        which: { "package-tool": realBinPath },
        latest: {},
        ls: {
          "package-tool": [
            {
              version: "2.1.241",
              install_path: NodePath.join(installsDir, "package-tool", "2.1.241"),
            },
          ],
        },
      });

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: NodePath.join(shimsDir, "package-tool"),
        env: {
          PATH: miseMockBinDir,
        },
      }).pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(MiseOwnedToolCache, new Map()),
      );

      expect(capabilities).toEqual({
        provider: driver("packageTool"),
        packageName: "@example/package-tool",
        update: {
          command: "mise upgrade package-tool",

          executable: "mise",

          args: ["upgrade", "package-tool"],

          lockKey: "mise",
        },
        managedLatest: {
          executable: "mise",

          args: ["latest", "package-tool"],
        },
      });
    }),
  );

  it.effect("detects mise-owned tools through shims that symlink to the mise binary", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-mise-shim-capabilities");
      const installsDir = NodePath.join(tempDir, ".local", "share", "mise", "installs");
      const packageToolBinDir = NodePath.join(installsDir, "package-tool", "2.1.241", "bin");
      NodeFS.mkdirSync(packageToolBinDir, { recursive: true });
      const realBinPath = NodePath.join(packageToolBinDir, "package-tool");
      NodeFS.writeFileSync(realBinPath, "#!/bin/sh\n");
      NodeFS.chmodSync(realBinPath, 0o755);
      // Real mise shims point at the mise executable, not the tool.
      const fakeMiseBinary = NodePath.join(tempDir, "bin", "mise");
      NodeFS.mkdirSync(NodePath.join(tempDir, "bin"), { recursive: true });
      NodeFS.writeFileSync(fakeMiseBinary, "#!/bin/sh\n");
      NodeFS.chmodSync(fakeMiseBinary, 0o755);
      const shimsDir = NodePath.join(tempDir, ".local", "share", "mise", "shims");
      NodeFS.mkdirSync(shimsDir, { recursive: true });
      NodeFS.symlinkSync(fakeMiseBinary, NodePath.join(shimsDir, "package-tool"));
      const miseMockBinDir = makeMiseMock(tempDir, {
        which: { "package-tool": realBinPath },
        latest: {},
        ls: {
          "package-tool": [
            {
              version: "2.1.241",
              install_path: NodePath.join(installsDir, "package-tool", "2.1.241"),
            },
          ],
        },
      });

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: NodePath.join(shimsDir, "package-tool"),
        env: {
          PATH: miseMockBinDir,
        },
      }).pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(MiseOwnedToolCache, new Map()),
      );

      expect(capabilities.update?.command).toBe("mise upgrade package-tool");
    }),
  );

  it.effect("matches mise which paths that pass through the latest symlink", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-mise-latest-symlink-capabilities");
      const installsDir = NodePath.join(tempDir, ".local", "share", "mise", "installs");
      const packageToolInstallDir = NodePath.join(installsDir, "package-tool", "2.1.241");
      NodeFS.mkdirSync(packageToolInstallDir, { recursive: true });
      const realBinPath = NodePath.join(packageToolInstallDir, "package-tool");
      NodeFS.writeFileSync(realBinPath, "#!/bin/sh\n");
      NodeFS.chmodSync(realBinPath, 0o755);
      const latestInstallDir = NodePath.join(installsDir, "package-tool", "latest");
      NodeFS.symlinkSync(packageToolInstallDir, latestInstallDir);
      const latestBinPath = NodePath.join(latestInstallDir, "package-tool");
      const miseMockBinDir = makeMiseMock(tempDir, {
        which: { "package-tool": latestBinPath },
        latest: {},
        ls: {
          "package-tool": [{ version: "2.1.241", install_path: packageToolInstallDir }],
        },
      });

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: latestBinPath,
        env: {
          PATH: miseMockBinDir,
        },
      }).pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(MiseOwnedToolCache, new Map()),
      );

      expect(capabilities.update?.command).toBe("mise upgrade package-tool");
    }),
  );

  it.effect("maps backend-flattened mise install dirs back to the configured tool name", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-mise-backend-capabilities");
      const installsDir = NodePath.join(tempDir, ".local", "share", "mise", "installs");
      const grokBinDir = NodePath.join(
        installsDir,
        "npm-example-grok",
        "1.0.5",
        "node_modules",
        ".bin",
      );
      NodeFS.mkdirSync(grokBinDir, { recursive: true });
      const realBinPath = NodePath.join(grokBinDir, "package-tool");
      NodeFS.writeFileSync(realBinPath, "#!/bin/sh\n");
      NodeFS.chmodSync(realBinPath, 0o755);
      const miseMockBinDir = makeMiseMock(tempDir, {
        which: { "package-tool": realBinPath },
        latest: {},
        ls: {
          "npm:@example/package-tool": [
            {
              version: "1.0.5",
              install_path: NodePath.join(installsDir, "npm-example-grok", "1.0.5"),
            },
          ],
        },
      });

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: realBinPath,
        env: {
          PATH: miseMockBinDir,
        },
      }).pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(MiseOwnedToolCache, new Map()),
      );

      expect(capabilities.update?.command).toBe("mise upgrade npm:@example/package-tool");
    }),
  );

  it.effect("keeps npm updates for packages exposed through a mise-managed runtime", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-mise-runtime-capabilities");
      const installsDir = NodePath.join(tempDir, ".local", "share", "mise", "installs");
      const binDir = NodePath.join(installsDir, "node", "26.7.0", "bin");
      const packageBinDir = NodePath.join(
        installsDir,
        "node",
        "26.7.0",
        "lib",
        "node_modules",
        "@example",
        "package-tool",
        "bin",
      );
      NodeFS.mkdirSync(binDir, { recursive: true });
      NodeFS.mkdirSync(packageBinDir, { recursive: true });
      const packageBinPath = NodePath.join(packageBinDir, "package-tool.js");
      const symlinkPath = NodePath.join(binDir, "package-tool");
      NodeFS.writeFileSync(packageBinPath, "#!/usr/bin/env node\n");
      NodeFS.chmodSync(packageBinPath, 0o755);
      NodeFS.symlinkSync(packageBinPath, symlinkPath);
      const fakeMiseBinary = NodePath.join(tempDir, "bin", "mise");
      NodeFS.mkdirSync(NodePath.dirname(fakeMiseBinary), { recursive: true });
      NodeFS.writeFileSync(fakeMiseBinary, "#!/bin/sh\n");
      NodeFS.chmodSync(fakeMiseBinary, 0o755);
      const shimsDir = NodePath.join(tempDir, ".local", "share", "mise", "shims");
      NodeFS.mkdirSync(shimsDir, { recursive: true });
      const miseShimPath = NodePath.join(shimsDir, "package-tool");
      NodeFS.symlinkSync(fakeMiseBinary, miseShimPath);
      const miseMockBinDir = makeMiseMock(tempDir, {
        which: { "package-tool": symlinkPath },
        latest: {},
        ls: {
          node: [{ version: "26.7.0", install_path: NodePath.join(installsDir, "node", "26.7.0") }],
        },
      });

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: miseShimPath,
        env: {
          PATH: miseMockBinDir,
        },
      }).pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(MiseOwnedToolCache, new Map()),
      );

      expect(capabilities.update).toMatchObject({
        executable: "npm",
        lockKey: "npm-global",
      });
    }),
  );

  it.effect("resolves managed latest versions through the tool manager's own recency gate", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-mise-latest");
      const miseMockBinDir = makeMiseMock(tempDir, {
        which: {},
        latest: { claude: "2.1.235" },
        ls: {},
      });
      const previousPath = process.env.PATH;
      process.env.PATH = `${miseMockBinDir}:${previousPath ?? ""}`;
      try {
        const capabilities = packageToolUpdate.resolveMiseManaged!("claude");
        expect(capabilities.managedLatest).toEqual({
          executable: "mise",
          args: ["latest", "claude"],
        });
        const version = yield* resolveLatestProviderVersion(capabilities).pipe(
          Effect.provideService(ProviderVersionCache, new Map()),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("managed latest should not hit the registry")),
          ),
        );
        expect(version).toBe("2.1.235");
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
      }
    }),
  );

  it.effect("falls back to registry latest when respecting the tool manager is disabled", () => {
    const urls: string[] = [];
    const capabilities = packageToolUpdate.resolveMiseManaged!("claude");
    return resolveLatestProviderVersion(capabilities, {
      respectPackageManagerReleaseAge: false,
    }).pipe(
      Effect.provideService(ProviderVersionCache, new Map()),
      Effect.provideService(
        HttpClient.HttpClient,
        registryHttpClient((url) => {
          urls.push(url);
          return { version: "3.0.0" };
        }),
      ),
      Effect.map((version) => {
        expect(urls).toEqual(["https://registry.npmjs.org/%40example%2Fpackage-tool/latest"]);
        expect(version).toBe("3.0.0");
      }),
    );
  });

  it.effect("uses Effect FileSystem realPath when detecting pnpm global symlinks", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-pnpm-realpath-capabilities");
      const binDir = NodePath.join(tempDir, "bin");
      const packageBinDir = NodePath.join(
        tempDir,
        ".local",
        "share",
        "pnpm",
        "global",
        "5",
        "node_modules",
        "@example",
        "package-tool",
        "bin",
      );
      NodeFS.mkdirSync(binDir, { recursive: true });
      NodeFS.mkdirSync(packageBinDir, { recursive: true });
      const packageBinPath = NodePath.join(packageBinDir, "package-tool.js");
      const symlinkPath = NodePath.join(binDir, "package-tool");
      NodeFS.writeFileSync(packageBinPath, "#!/usr/bin/env node\n");
      NodeFS.chmodSync(packageBinPath, 0o755);
      NodeFS.symlinkSync(packageBinPath, symlinkPath);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: symlinkPath,
        env: {
          PATH: "",
        },
      });

      expect(capabilities).toEqual({
        provider: driver("packageTool"),
        packageName: "@example/package-tool",
        update: {
          command: "pnpm add -g @example/package-tool@latest",

          executable: "pnpm",

          args: ["add", "-g", "@example/package-tool@latest"],

          lockKey: "pnpm-global",
        },
      });
    }),
  );

  it("allows the package's own install scripts in npm global updates", () => {
    const claudeUpdate = makePackageManagedProviderMaintenanceResolver({
      provider: driver("claudeAgent"),
      npmPackageName: "@anthropic-ai/claude-code",
      homebrewFormula: "claude-code",
      nativeUpdate: {
        executable: "claude",
        args: ["update"],
        lockKey: "claude-native",
        isCommandPath: isNativeTestCommandPath("/.local/bin/claude"),
      },
    });

    expect(claudeUpdate.resolve()).toEqual({
      provider: driver("claudeAgent"),
      packageName: "@anthropic-ai/claude-code",
      update: {
        command:
          "npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest",

        executable: "npm",

        args: [
          "install",
          "-g",
          "--allow-scripts=@anthropic-ai/claude-code",
          "@anthropic-ai/claude-code@latest",
        ],

        lockKey: "npm-global",
      },
    });
  });

  it("disables one-click updates for explicit custom binary paths it cannot safely map", () => {
    expect(
      packageToolUpdate.resolve({
        binaryPath: "C:\\Tools\\package-tool\\package-tool.exe",
        env: {
          PATH: "",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      }),
    ).toEqual({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      update: null,
    });
  });

  it.effect("uses registry latest when package-manager recency is off", () => {
    const urls: string[] = [];
    return enrichProviderSnapshotWithVersionAdvisory(
      installedPackageToolProvider,
      packageToolUpdate.resolve(),
      {
        enableProviderUpdateChecks: true,
        respectPackageManagerReleaseAge: false,
      },
    ).pipe(
      Effect.provideService(ProviderVersionCache, new Map()),
      Effect.provideService(
        HttpClient.HttpClient,
        registryHttpClient((url) => {
          urls.push(url);
          return { version: "2.0.0" };
        }),
      ),
      Effect.provideService(
        PackageManagerReleaseAge,
        packageManagerReleaseAge(Date.parse("2026-08-13T00:00:00.000Z")),
      ),
      Effect.map((provider) => {
        expect(urls).toEqual(["https://registry.npmjs.org/%40example%2Fpackage-tool/latest"]);
        expect(provider.versionAdvisory).toMatchObject({
          status: "behind_latest",
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
        });
      }),
    );
  });

  it.effect("walks back to the installable latest when npm recency blocks registry latest", () => {
    const urls: string[] = [];
    const cutoff = Date.parse("2026-08-13T00:00:00.000Z");
    return enrichProviderSnapshotWithVersionAdvisory(
      installedPackageToolProvider,
      packageToolUpdate.resolve(),
      {
        enableProviderUpdateChecks: true,
        respectPackageManagerReleaseAge: true,
      },
    ).pipe(
      Effect.provideService(ProviderVersionCache, new Map()),
      Effect.provideService(
        HttpClient.HttpClient,
        registryHttpClient((url) => {
          urls.push(url);
          return {
            "dist-tags": { latest: "2.0.0" },
            time: {
              "1.0.0": "2026-07-01T00:00:00.000Z",
              "1.5.0": "2026-08-07T00:00:00.000Z",
              "2.0.0": "2026-08-20T00:00:00.000Z",
            },
          };
        }),
      ),
      Effect.provideService(PackageManagerReleaseAge, packageManagerReleaseAge(cutoff)),
      Effect.map((provider) => {
        expect(urls).toEqual(["https://registry.npmjs.org/%40example%2Fpackage-tool"]);
        expect(provider.versionAdvisory).toMatchObject({
          status: "behind_latest",
          currentVersion: "1.0.0",
          latestVersion: "1.5.0",
        });
      }),
    );
  });

  it.effect(
    "treats the provider as current when the installable latest matches the installed version",
    () => {
      const cutoff = Date.parse("2026-08-13T00:00:00.000Z");
      return enrichProviderSnapshotWithVersionAdvisory(
        installedPackageToolProvider,
        packageToolUpdate.resolve(),
        {
          enableProviderUpdateChecks: true,
          respectPackageManagerReleaseAge: true,
        },
      ).pipe(
        Effect.provideService(ProviderVersionCache, new Map()),
        Effect.provideService(
          HttpClient.HttpClient,
          registryHttpClient(() => ({
            "dist-tags": { latest: "2.0.0" },
            time: {
              "1.0.0": "2026-08-07T00:00:00.000Z",
              "2.0.0": "2026-08-20T00:00:00.000Z",
            },
          })),
        ),
        Effect.provideService(PackageManagerReleaseAge, packageManagerReleaseAge(cutoff)),
        Effect.map((provider) => {
          expect(provider.versionAdvisory).toMatchObject({
            status: "current",
            currentVersion: "1.0.0",
            latestVersion: "1.0.0",
          });
        }),
      );
    },
  );

  it.effect("ignores package-manager recency for Homebrew-managed binaries", () => {
    const urls: string[] = [];
    return enrichProviderSnapshotWithVersionAdvisory(
      installedPackageToolProvider,
      packageToolUpdate.resolve({
        binaryPath: "/opt/homebrew/bin/package-tool",
        env: { PATH: "" },
      }),
      {
        enableProviderUpdateChecks: true,
        respectPackageManagerReleaseAge: true,
      },
    ).pipe(
      Effect.provideService(ProviderVersionCache, new Map()),
      Effect.provideService(
        HttpClient.HttpClient,
        registryHttpClient((url) => {
          urls.push(url);
          return { version: "2.0.0" };
        }),
      ),
      Effect.provideService(
        PackageManagerReleaseAge,
        packageManagerReleaseAge(Date.parse("2026-08-13T00:00:00.000Z")),
      ),
      Effect.map((provider) => {
        expect(urls).toEqual(["https://registry.npmjs.org/%40example%2Fpackage-tool/latest"]);
        expect(provider.versionAdvisory).toMatchObject({
          status: "behind_latest",
          latestVersion: "2.0.0",
        });
      }),
    );
  });
});
