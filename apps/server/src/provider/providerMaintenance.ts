// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 4_000;
const PACKAGE_MANAGER_CONFIG_TIMEOUT_MS = 2_000;
const MANAGED_LATEST_TIMEOUT_MS = 10_000;
const NPM_GLOBAL_UPDATE_LOCK_KEY = "npm-global";
const PNPM_GLOBAL_UPDATE_LOCK_KEY = "pnpm-global";
const BUN_GLOBAL_UPDATE_LOCK_KEY = "bun-global";
const MISE_UPDATE_LOCK_KEY = "mise";
const PACKUMENT_TIME_META_KEYS = new Set(["created", "modified"]);
const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = "Install the update now or review provider settings.";
const BUN_MINIMUM_RELEASE_AGE_SCRIPT = [
  "const home = require('os').homedir();",
  "const path = require('path');",
  "const fs = require('fs');",
  "const file = path.join(home, '.bunfig.toml');",
  "if (!fs.existsSync(file)) { console.log(''); process.exit(0); }",
  "const text = fs.readFileSync(file, 'utf8');",
  "const match = /minimumReleaseAge\\s*=\\s*(\\d+)/.exec(text);",
  "console.log(match ? match[1] : '');",
].join(" ");

const compactEnv = (input: Record<string, Option.Option<string>>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      Option.match(value, {
        onNone: () => [],
        onSome: (resolved) => [[key, resolved]],
      }),
    ),
  );

const CommandLookupEnvConfig = Config.all({
  PATH: Config.string("PATH").pipe(Config.option),
  Path: Config.string("Path").pipe(Config.option),
  path: Config.string("path").pipe(Config.option),
  PATHEXT: Config.string("PATHEXT").pipe(Config.option),
}).pipe(Config.map(compactEnv));

const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})));

export interface ProviderMaintenanceManagedLatest {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /**
   * When the owning tool manager (currently mise) resolves "latest" through its
   * own release-age gate, latest versions come from here instead of the npm registry.
   */
  readonly managedLatest?: ProviderMaintenanceManagedLatest | null;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
}

export interface ProviderMaintenanceCapabilityResolutionOptions {
  readonly binaryPath?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly resolvedCommandPath?: string | null;
  readonly realCommandPath?: string | null;
}

export interface ProviderMaintenanceCapabilitiesResolver {
  readonly resolve: (
    options?: ProviderMaintenanceCapabilityResolutionOptions,
  ) => ProviderMaintenanceCapabilities;
  readonly resolveMiseManaged?: (toolName: string) => ProviderMaintenanceCapabilities;
}

export interface PackageManagedProviderMaintenanceDefinition {
  readonly provider: ProviderDriverKind;
  readonly npmPackageName: string;
  readonly homebrewFormula: string | null;
  readonly nativeUpdate: {
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly lockKey: string;
    readonly isCommandPath: (commandPath: string) => boolean;
  } | null;
}

export interface ProviderVersionCacheEntry {
  readonly expiresAt: number;
  readonly version: string | null;
}

export const ProviderVersionCache = Context.Reference<Map<string, ProviderVersionCacheEntry>>(
  "@t3tools/server/providerMaintenance/ProviderVersionCache",
  {
    defaultValue: () => new Map(),
  },
);

export interface PackageManagerReleaseAgeCutoffCacheEntry {
  readonly expiresAt: number;
  readonly beforeMs: number | null;
}

export const PackageManagerReleaseAgeCutoffCache = Context.Reference<
  Map<string, PackageManagerReleaseAgeCutoffCacheEntry>
>("@t3tools/server/providerMaintenance/PackageManagerReleaseAgeCutoffCache", {
  defaultValue: () => new Map(),
});

export interface PackageManagerReleaseAge {
  readonly getCutoffMs: (input: {
    readonly lockKey: string;
    readonly nowMs: number;
  }) => Effect.Effect<number | null>;
}

export const PackageManagerReleaseAge = Context.Reference<PackageManagerReleaseAge>(
  "@t3tools/server/providerMaintenance/PackageManagerReleaseAge",
  {
    defaultValue: () => ({
      getCutoffMs: (input) => readCachedPackageManagerReleaseAgeCutoff(input),
    }),
  },
);

export interface MiseOwnedToolCacheEntry {
  readonly expiresAt: number;
  readonly commandPath: string | null;
  readonly toolName: string | null;
}

export const MiseOwnedToolCache = Context.Reference<Map<string, MiseOwnedToolCacheEntry>>(
  "@t3tools/server/providerMaintenance/MiseOwnedToolCache",
  {
    defaultValue: () => new Map(),
  },
);

const NpmLatestVersionResponse = Schema.Struct({
  version: Schema.optional(Schema.String),
});

const NpmPackumentResponse = Schema.Struct({
  "dist-tags": Schema.optional(
    Schema.Struct({
      latest: Schema.optional(Schema.String),
    }),
  ),
  time: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const decodeNpmLatestVersionResponse = Schema.decodeUnknownEffect(NpmLatestVersionResponse);
const decodeNpmPackumentResponse = Schema.decodeUnknownEffect(NpmPackumentResponse);

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseNpmBeforeConfigValue(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "null" || lowered === "undefined" || lowered === "false" || lowered === "none") {
    return null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNonNegativeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "null" || lowered === "undefined" || lowered === "false" || lowered === "none") {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function cutoffFromAge(nowMs: number, ageMs: number): number | null {
  return ageMs === 0 ? null : nowMs - ageMs;
}

export function parseManagedLatestVersion(value: string | null): string | null {
  if (!value) {
    return null;
  }
  for (const line of value.trim().split(/\r?\n/)) {
    const candidate = line.trim().replace(/^v/, "");
    if (candidate && parseSemver(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function pickInstallableLatest(input: {
  readonly distTagLatest: string | null;
  readonly times: Readonly<Record<string, string>>;
  readonly beforeMs: number | null;
}): string | null {
  const distTagLatest = input.distTagLatest;
  const beforeMs = input.beforeMs;
  if (beforeMs === null) {
    return distTagLatest;
  }

  const isPublishedOnOrBeforeCutoff = (version: string): boolean => {
    const publishedAt = input.times[version];
    if (!publishedAt) {
      return false;
    }
    const publishedMs = Date.parse(publishedAt);
    return Number.isFinite(publishedMs) && publishedMs <= beforeMs;
  };

  if (distTagLatest && isPublishedOnOrBeforeCutoff(distTagLatest)) {
    return distTagLatest;
  }

  let latest: string | null = null;
  for (const version of Object.keys(input.times)) {
    if (PACKUMENT_TIME_META_KEYS.has(version)) {
      continue;
    }
    if (!isPublishedOnOrBeforeCutoff(version)) {
      continue;
    }
    const parsed = parseSemver(version);
    if (!parsed || parsed.prerelease.length > 0) {
      continue;
    }
    if (latest === null || compareSemverVersions(version, latest) > 0) {
      latest = version;
    }
  }
  return latest;
}

const execFileUtf8 = (
  command: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly timeoutMs?: number;
    readonly maxBufferBytes?: number;
    readonly env?: NodeJS.ProcessEnv | undefined;
  },
) => {
  const timeoutMs = options?.timeoutMs ?? PACKAGE_MANAGER_CONFIG_TIMEOUT_MS;
  return Effect.callback<string, Error>((resume) => {
    const child = NodeChildProcess.execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: options?.maxBufferBytes ?? 4 * 1024 * 1024,
        windowsHide: true,
        // Callers carry PATH-style lookup vars; keep the rest of our environment
        // so tools like mise can still find their home and config.
        env: options?.env ? { ...process.env, ...options.env } : undefined,
      },
      (error, stdout) => {
        if (error) {
          resume(Effect.fail(error));
          return;
        }
        resume(Effect.succeed(typeof stdout === "string" ? stdout : String(stdout)));
      },
    );
    return Effect.sync(() => {
      child.kill();
    });
  }).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.map((result) => (Option.isNone(result) ? null : result.value.trim())),
    Effect.orElseSucceed(() => null),
  );
};

const readLivePackageManagerReleaseAgeCutoff = Effect.fn("readLivePackageManagerReleaseAgeCutoff")(
  function* (input: { readonly lockKey: string; readonly nowMs: number }) {
    switch (input.lockKey) {
      case NPM_GLOBAL_UPDATE_LOCK_KEY: {
        const before = yield* execFileUtf8("npm", ["config", "get", "before"]);
        const beforeMs = before ? parseNpmBeforeConfigValue(before) : null;
        if (beforeMs !== null) {
          return beforeMs;
        }
        const minReleaseAge = yield* execFileUtf8("npm", ["config", "get", "min-release-age"]);
        const days = minReleaseAge ? parseNonNegativeNumber(minReleaseAge) : null;
        return days === null ? null : cutoffFromAge(input.nowMs, days * 24 * 60 * 60 * 1_000);
      }
      case PNPM_GLOBAL_UPDATE_LOCK_KEY: {
        const stdout = yield* execFileUtf8("pnpm", ["config", "get", "minimumReleaseAge"]);
        const minutes = stdout ? parseNonNegativeNumber(stdout) : null;
        return minutes === null ? null : cutoffFromAge(input.nowMs, minutes * 60 * 1_000);
      }
      case BUN_GLOBAL_UPDATE_LOCK_KEY: {
        const stdout = yield* execFileUtf8("bun", ["-e", BUN_MINIMUM_RELEASE_AGE_SCRIPT]);
        const seconds = stdout ? parseNonNegativeNumber(stdout) : null;
        return seconds === null ? null : cutoffFromAge(input.nowMs, seconds * 1_000);
      }
      default:
        return null;
    }
  },
);

const readCachedPackageManagerReleaseAgeCutoff = Effect.fn(
  "readCachedPackageManagerReleaseAgeCutoff",
)(function* (input: { readonly lockKey: string; readonly nowMs: number }) {
  const cache = yield* PackageManagerReleaseAgeCutoffCache;
  const cached = cache.get(input.lockKey);
  if (cached && cached.expiresAt > input.nowMs) {
    return cached.beforeMs;
  }
  const beforeMs = yield* readLivePackageManagerReleaseAgeCutoff(input);
  cache.set(input.lockKey, {
    expiresAt: input.nowMs + LATEST_VERSION_CACHE_TTL_MS,
    beforeMs,
  });
  return beforeMs;
});

const MiseInstalledTool = Schema.Struct({
  install_path: Schema.optional(Schema.String),
});

const MiseLsResponse = Schema.Record(Schema.String, Schema.Array(MiseInstalledTool));

const decodeMiseLsResponse = Schema.decodeEffect(Schema.fromJsonString(MiseLsResponse));

// mise owns a provider binary when `mise which` resolves it and the owning
// configured tool's install dir contains it. The longest matching install dir
// wins so backend-flattened names like npm:@xai-official/grok still map back.
const readLiveMiseCommandResolution = Effect.fn("readLiveMiseCommandResolution")(function* (input: {
  readonly binaryName: string;
  readonly packageName: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
}) {
  const whichPath = yield* execFileUtf8("mise", ["which", input.binaryName], { env: input.env });
  if (!whichPath) {
    return { commandPath: null, toolName: null };
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const realWhichPath = yield* fileSystem
    .realPath(whichPath)
    .pipe(Effect.orElseSucceed(() => whichPath));
  const lsJson = yield* execFileUtf8("mise", ["ls", "--json"], {
    env: input.env,
    timeoutMs: MANAGED_LATEST_TIMEOUT_MS,
  });
  if (!lsJson) {
    return { commandPath: realWhichPath, toolName: null };
  }
  const payload = yield* decodeMiseLsResponse(lsJson).pipe(Effect.orElseSucceed(() => null));
  if (!payload) {
    return { commandPath: realWhichPath, toolName: null };
  }
  const normalizedWhichPath = normalizeCommandPath(realWhichPath);
  let ownedToolName: string | null = null;
  let ownedInstallPathLength = -1;
  for (const [toolName, installs] of Object.entries(payload)) {
    // A runtime managed by mise can expose unrelated global executables from
    // its install tree (for example npm-global OpenCode under mise's Node).
    // Only the provider's direct tool or its matching npm backend owns it.
    if (toolName !== input.binaryName && toolName !== `npm:${input.packageName}`) {
      continue;
    }
    for (const install of installs) {
      const installPath = nonEmptyString(install.install_path);
      if (!installPath) {
        continue;
      }
      const normalizedInstallPath = normalizeCommandPath(installPath);
      if (
        normalizedWhichPath.startsWith(`${normalizedInstallPath}/`) &&
        normalizedInstallPath.length > ownedInstallPathLength
      ) {
        ownedInstallPathLength = normalizedInstallPath.length;
        ownedToolName = toolName;
      }
    }
  }
  return { commandPath: realWhichPath, toolName: ownedToolName };
});

const readCachedMiseCommandResolution = Effect.fn("readCachedMiseCommandResolution")(
  function* (input: {
    readonly binaryName: string;
    readonly packageName: string;
    readonly commandPath: string;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly nowMs: number;
  }) {
    const cache = yield* MiseOwnedToolCache;
    const cacheKey = [
      input.binaryName,
      input.packageName,
      normalizeCommandPath(input.commandPath),
    ].join("\0");
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > input.nowMs) {
      return { commandPath: cached.commandPath, toolName: cached.toolName };
    }
    const resolution = yield* readLiveMiseCommandResolution({
      binaryName: input.binaryName,
      packageName: input.packageName,
      env: input.env,
    });
    cache.set(cacheKey, {
      expiresAt: input.nowMs + LATEST_VERSION_CACHE_TTL_MS,
      ...resolution,
    });
    return resolution;
  },
);

export function makeProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
  readonly managedLatest?: ProviderMaintenanceManagedLatest;
}): ProviderMaintenanceCapabilities {
  const update =
    input.updateExecutable === null || input.updateLockKey === null
      ? null
      : {
          command: [input.updateExecutable, ...input.updateArgs].join(" "),
          executable: input.updateExecutable,
          args: input.updateArgs,
          lockKey: input.updateLockKey,
        };
  return {
    provider: input.provider,
    packageName: input.packageName,
    update,
    ...(input.managedLatest ? { managedLatest: input.managedLatest } : {}),
  };
}

export function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
}): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: input.provider,
    packageName: input.packageName,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
  });
}

function makeNpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "npm",
    // npm 12 blocks install scripts by default (empty allow-scripts allowlist)
    // and still exits 0, so a package whose postinstall finishes the install
    // (claude copies its native binary over a placeholder stub) is left broken
    // while the update reports success. Allow this one package's scripts.
    // Older npm warns about the unknown config and continues.
    updateArgs: [
      "install",
      "-g",
      `--allow-scripts=${definition.npmPackageName}`,
      `${definition.npmPackageName}@latest`,
    ],
    updateLockKey: NPM_GLOBAL_UPDATE_LOCK_KEY,
  });
}

function makeBunGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "bun",
    updateArgs: ["i", "-g", `${definition.npmPackageName}@latest`],
    updateLockKey: BUN_GLOBAL_UPDATE_LOCK_KEY,
  });
}

function makePnpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "pnpm",
    updateArgs: ["add", "-g", `${definition.npmPackageName}@latest`],
    updateLockKey: PNPM_GLOBAL_UPDATE_LOCK_KEY,
  });
}

function makeVitePlusGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "vp",
    updateArgs: ["i", "-g", definition.npmPackageName],
    updateLockKey: "vite-plus-global",
  });
}

function makeHomebrewProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  if (!definition.homebrewFormula) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
    });
  }

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "brew",
    updateArgs: ["upgrade", definition.homebrewFormula],
    updateLockKey: "homebrew",
  });
}

// mise gates its own "latest" resolution behind minimum_release_age (24h by
// default, plus per-tool overrides and excludes), so both the upgrade and the
// latest-version lookup defer to mise instead of the npm registry.
function makeMiseManagedProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  toolName: string,
): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "mise",
    updateArgs: ["upgrade", toolName],
    updateLockKey: MISE_UPDATE_LOCK_KEY,
    managedLatest: { executable: "mise", args: ["latest", toolName] },
  });
}

function makeNativeProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities | null {
  if (!definition.nativeUpdate) {
    return null;
  }

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: definition.nativeUpdate.executable,
    updateArgs: definition.nativeUpdate.args,
    updateLockKey: definition.nativeUpdate.lockKey,
  });
}

export function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

function isMiseInstallsCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  // Shims are symlinks to the mise binary itself, so realpath never reaches
  // the installs tree; the shim location is what survives resolution.
  return normalized.includes("/mise/installs/") || normalized.includes("/mise/shims/");
}

function isBunGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.bun/bin/");
}

function isVitePlusGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.vite-plus/bin/");
}

function isPnpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/.local/share/pnpm/") ||
    normalized.includes("/library/pnpm/") ||
    normalized.includes("/local/share/pnpm/") ||
    normalized.includes("/appdata/local/pnpm/") ||
    normalized.includes("/pnpm/global/")
  );
}

function isNpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/node_modules/.bin/") ||
    normalized.includes("/lib/node_modules/") ||
    normalized.includes("/npm/node_modules/")
  );
}

function isHomebrewCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/opt/homebrew/cellar/") ||
    normalized.includes("/usr/local/cellar/") ||
    normalized.includes("/homebrew/cellar/") ||
    normalized.includes("/opt/homebrew/caskroom/") ||
    normalized.includes("/usr/local/caskroom/") ||
    normalized.includes("/homebrew/caskroom/") ||
    normalized.startsWith("/opt/homebrew/bin/") ||
    normalized.startsWith("/usr/local/bin/")
  );
}

export function resolvePackageManagedProviderMaintenance(
  definition: PackageManagedProviderMaintenanceDefinition,
  options?: ProviderMaintenanceCapabilityResolutionOptions,
): ProviderMaintenanceCapabilities {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return makeNpmGlobalProviderMaintenanceCapabilities(definition);
  }

  const resolvedCommandPath =
    options?.resolvedCommandPath ?? (hasPathSeparator(binaryPath) ? binaryPath : null);

  if (resolvedCommandPath) {
    const commandPaths = [
      resolvedCommandPath,
      ...(options?.realCommandPath ? [options.realCommandPath] : []),
    ];

    const nativeUpdate = definition.nativeUpdate;
    if (
      nativeUpdate &&
      commandPaths.some((commandPath) => nativeUpdate.isCommandPath(commandPath))
    ) {
      return (
        makeNativeProviderMaintenanceCapabilities(definition) ??
        makeNpmGlobalProviderMaintenanceCapabilities(definition)
      );
    }
    if (commandPaths.some(isVitePlusGlobalCommandPath)) {
      return makeVitePlusGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some(isBunGlobalCommandPath)) {
      return makeBunGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some(isPnpmGlobalCommandPath)) {
      return makePnpmGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some(isNpmGlobalCommandPath)) {
      return makeNpmGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some(isHomebrewCommandPath)) {
      return makeHomebrewProviderMaintenanceCapabilities(definition);
    }
  }

  if (!hasPathSeparator(binaryPath)) {
    return makeNpmGlobalProviderMaintenanceCapabilities(definition);
  }

  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
  });
}

export function makePackageManagedProviderMaintenanceResolver(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: (options) => resolvePackageManagedProviderMaintenance(definition, options),
    resolveMiseManaged: (toolName) =>
      makeMiseManagedProviderMaintenanceCapabilities(definition, toolName),
  };
}

export function makeStaticProviderMaintenanceResolver(
  capabilities: ProviderMaintenanceCapabilities,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: () => capabilities,
  };
}

function makeManualProviderMaintenanceCapabilities(
  provider: ProviderDriverKind,
): ProviderMaintenanceCapabilities {
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });
}

export const resolveProviderMaintenanceCapabilitiesEffect = Effect.fn(
  "resolveProviderMaintenanceCapabilitiesEffect",
)(function* (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  options?: Omit<ProviderMaintenanceCapabilityResolutionOptions, "realCommandPath">,
) {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return resolver.resolve(options);
  }

  const env = options?.env ?? (yield* readCommandLookupEnv);
  const resolvedCommandPath =
    (yield* resolveCommandPath(binaryPath, { env }).pipe(
      Effect.catchTag("CommandResolutionError", () => Effect.succeed(null)),
    )) ?? (hasPathSeparator(binaryPath) ? binaryPath : null);
  if (!resolvedCommandPath) {
    return resolver.resolve(options);
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const realCommandPath = yield* fileSystem
    .realPath(resolvedCommandPath)
    .pipe(Effect.orElseSucceed(() => resolvedCommandPath));
  const resolvedCapabilities = resolver.resolve({
    ...options,
    env,
    resolvedCommandPath,
    realCommandPath,
  });
  const commandPaths = [resolvedCommandPath, realCommandPath];
  if (
    resolver.resolveMiseManaged &&
    resolvedCapabilities.packageName &&
    commandPaths.some(isMiseInstallsCommandPath)
  ) {
    const binaryName = binaryPath.split(/[\\/]/).pop() ?? binaryPath;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const miseResolution = yield* readCachedMiseCommandResolution({
      binaryName,
      packageName: resolvedCapabilities.packageName,
      commandPath: resolvedCommandPath,
      env,
      nowMs: now,
    });
    if (miseResolution.toolName) {
      return resolver.resolveMiseManaged(miseResolution.toolName);
    }
    if (miseResolution.commandPath) {
      return resolver.resolve({
        ...options,
        env,
        resolvedCommandPath: miseResolution.commandPath,
        realCommandPath: miseResolution.commandPath,
      });
    }
  }
  return resolvedCapabilities;
});

function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
}): Pick<ServerProviderVersionAdvisory, "status" | "message"> {
  if (!input.currentVersion) {
    return { status: "unknown", message: null };
  }
  if (!input.latestVersion) {
    return { status: "unknown", message: null };
  }
  if (compareSemverVersions(input.currentVersion, input.latestVersion) < 0) {
    return {
      status: "behind_latest",
      message: PROVIDER_UPDATE_ACTION_TOAST_MESSAGE,
    };
  }
  return { status: "current", message: null };
}

export function createProviderVersionAdvisory(input: {
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly latestVersion?: string | null;
  readonly checkedAt?: string | null;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}): ServerProviderVersionAdvisory {
  const capabilities =
    input.maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(input.driver);
  const latestVersion = input.latestVersion ?? null;
  const advisory = deriveVersionAdvisory({
    currentVersion: input.currentVersion,
    latestVersion,
  });

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand: capabilities.update?.command ?? null,
    canUpdate: capabilities.update !== null,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
  };
}

const fetchRegistryJson = Effect.fn("fetchRegistryJson")(function* (path: string) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(`https://registry.npmjs.org/${path}`).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
  );
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(response)) {
    return null;
  }
  const httpResponse = response.value;
  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    return null;
  }
  return yield* httpResponse.json.pipe(Effect.orElseSucceed(() => null));
});

const fetchNpmLatestVersion = Effect.fn("fetchNpmLatestVersion")(function* (packageName: string) {
  const payload = yield* fetchRegistryJson(`${encodeURIComponent(packageName)}/latest`).pipe(
    Effect.flatMap((json) =>
      json === null
        ? Effect.succeed(null)
        : decodeNpmLatestVersionResponse(json).pipe(Effect.orElseSucceed(() => null)),
    ),
  );
  return payload ? nonEmptyString(payload.version) : null;
});

const fetchNpmInstallableLatestVersion = Effect.fn("fetchNpmInstallableLatestVersion")(function* (
  packageName: string,
  beforeMs: number,
) {
  const payload = yield* fetchRegistryJson(encodeURIComponent(packageName)).pipe(
    Effect.flatMap((json) =>
      json === null
        ? Effect.succeed(null)
        : decodeNpmPackumentResponse(json).pipe(Effect.orElseSucceed(() => null)),
    ),
  );
  if (!payload) {
    return null;
  }
  return pickInstallableLatest({
    distTagLatest: nonEmptyString(payload["dist-tags"]?.latest),
    times: payload.time ?? {},
    beforeMs,
  });
});

export const resolveLatestProviderVersion = Effect.fn("resolveLatestProviderVersion")(function* (
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
  options?: {
    readonly respectPackageManagerReleaseAge?: boolean;
  },
) {
  const packageName = maintenanceCapabilities.packageName;
  if (!packageName) {
    return null;
  }

  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const latestVersionCache = yield* ProviderVersionCache;

  // Tool managers like mise apply their own release-age gate when resolving
  // "latest", so ask them directly instead of comparing against registry latest.
  const managedLatest =
    options?.respectPackageManagerReleaseAge === false
      ? null
      : (maintenanceCapabilities.managedLatest ?? null);
  if (managedLatest) {
    const managedCacheKey = `${packageName}@managed:${[managedLatest.executable, ...managedLatest.args].join(" ")}`;
    const cachedManaged = latestVersionCache.get(managedCacheKey);
    if (cachedManaged && cachedManaged.expiresAt > now) {
      return cachedManaged.version;
    }
    const env = yield* readCommandLookupEnv;
    const stdout = yield* execFileUtf8(managedLatest.executable, [...managedLatest.args], {
      timeoutMs: MANAGED_LATEST_TIMEOUT_MS,
      env,
    });
    const version = parseManagedLatestVersion(stdout);
    latestVersionCache.set(managedCacheKey, {
      expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
      version,
    });
    return version;
  }

  const lockKey = maintenanceCapabilities.update?.lockKey ?? null;
  const cutoffMs =
    options?.respectPackageManagerReleaseAge !== false && lockKey
      ? yield* (yield* PackageManagerReleaseAge).getCutoffMs({ lockKey, nowMs: now })
      : null;
  const cacheKey = cutoffMs === null ? packageName : `${packageName}@before:${cutoffMs}`;
  const cached = latestVersionCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.version;
  }

  const version =
    cutoffMs === null
      ? yield* fetchNpmLatestVersion(packageName)
      : yield* fetchNpmInstallableLatestVersion(packageName, cutoffMs);
  latestVersionCache.set(cacheKey, {
    expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
    version,
  });
  return version;
});

export const enrichProviderSnapshotWithVersionAdvisory = Effect.fn(
  "enrichProviderSnapshotWithVersionAdvisory",
)(function* (
  snapshot: ServerProvider,
  maintenanceCapabilities?: ProviderMaintenanceCapabilities,
  options?: {
    readonly enableProviderUpdateChecks: boolean | undefined;
    readonly respectPackageManagerReleaseAge?: boolean | undefined;
  },
) {
  const capabilities =
    maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(snapshot.driver);
  const shouldResolveLatestVersion =
    options?.enableProviderUpdateChecks !== false &&
    snapshot.enabled &&
    snapshot.installed &&
    Boolean(snapshot.version);
  if (!shouldResolveLatestVersion) {
    return {
      ...snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: snapshot.driver,
        currentVersion: snapshot.version,
        checkedAt: snapshot.checkedAt,
        maintenanceCapabilities: capabilities,
      }),
    };
  }

  const latestVersionOptions =
    options?.respectPackageManagerReleaseAge === undefined
      ? undefined
      : { respectPackageManagerReleaseAge: options.respectPackageManagerReleaseAge };
  const latestVersion = yield* resolveLatestProviderVersion(capabilities, latestVersionOptions);
  return {
    ...snapshot,
    versionAdvisory: createProviderVersionAdvisory({
      driver: snapshot.driver,
      currentVersion: snapshot.version,
      latestVersion,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      maintenanceCapabilities: capabilities,
    }),
  };
});
