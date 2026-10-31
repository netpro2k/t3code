// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

export type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceCommandAction,
} from "@t3tools/provider-core/server/maintenance";
import type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceCommandAction,
} from "@t3tools/provider-core/server/maintenance";
import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { compareSemverVersions, satisfiesSemverRange, parseSemver } from "@t3tools/shared/semver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectUint8StreamText } from "./collectStreamText.ts";
import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 4_000;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_BYTES = 256 * 1_024;
const MISE_WRAPPER_MAX_BYTES = 16 * 1_024;
const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = "Install the update now or review provider settings.";

const MAINTENANCE_CAPABILITIES_CACHE_TTL = Duration.hours(1);

const PACKAGE_MANAGER_CONFIG_TIMEOUT_MS = 2_000;
const MANAGED_LATEST_TIMEOUT_MS = 10_000;
const NPM_GLOBAL_UPDATE_LOCK_KEY = "npm-global";
const BUN_GLOBAL_UPDATE_LOCK_KEY = "bun-global";
const MISE_UPDATE_LOCK_KEY = "mise";
const PACKUMENT_TIME_META_KEYS = new Set(["created", "modified"]);
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
  PATH: Config.String("PATH").pipe(Config.option),
  Path: Config.String("Path").pipe(Config.option),
  path: Config.String("path").pipe(Config.option),
  PATHEXT: Config.String("PATHEXT").pipe(Config.option),
}).pipe(Config.map(compactEnv));

const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})));

export interface ProviderMaintenanceResolutionContext {
  readonly binaryPath: string;
  readonly resolvedCommandPath: string;
  readonly realCommandPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

export type ProviderMaintenanceResolverServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

export interface ProviderMaintenanceCapabilitiesResolver {
  readonly resolve: (
    context: ProviderMaintenanceResolutionContext | null,
  ) => Effect.Effect<ProviderMaintenanceCapabilities, never, ProviderMaintenanceResolverServices>;
}

export interface PackageManagedProviderMaintenanceDefinition {
  readonly provider: ProviderDriverKind;
  readonly npmPackageName: string;
  readonly nativeUpdate: {
    readonly args: ReadonlyArray<string>;
    readonly isCommandPath?: (commandPath: string) => boolean;
    /** The updater cannot detect installs outside `isCommandPath`, so leave those manual-only. */
    readonly requiresCommandPath?: boolean;
    readonly env?:
      | NodeJS.ProcessEnv
      | ((context: ProviderMaintenanceResolutionContext) => NodeJS.ProcessEnv);
  } | null;
}

const NpmLatestVersionResponse = Schema.Struct({
  version: Schema.optional(Schema.String),
});

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function quoteShellWord(word: string, platform: NodeJS.Platform): string {
  const safeWord = platform === "win32" ? /^[\w./:\\@=-]+$/ : /^[\w./:@=-]+$/;
  if (safeWord.test(word)) return word;
  return platform === "win32"
    ? `'${word.replace(/['\u2018\u2019]/g, "$&$&")}'`
    : `'${word.replaceAll("'", "'\\''")}'`;
}

function quoteUpdateExecutable(executable: string, platform: NodeJS.Platform): string {
  const quoted = quoteShellWord(executable, platform);
  // Windows terminals default to PowerShell, where a quoted executable needs &.
  return platform === "win32" && quoted !== executable ? `& ${quoted}` : quoted;
}

export interface PackageManagerReleaseAgeCutoffCacheEntry {
  readonly expiresAt: number;
  readonly beforeMs: number | null;
}

const PackageManagerReleaseAgeCutoffCache = Context.Reference<
  Map<string, PackageManagerReleaseAgeCutoffCacheEntry>
>("@t3tools/server/providerMaintenance/PackageManagerReleaseAgeCutoffCache", {
  defaultValue: () => new Map(),
});

export interface PackageManagerReleaseAge {
  readonly getCutoffMs: (input: {
    readonly lockKey: string;
    readonly nowMs: number;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly npmPrefix?: string | undefined;
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
const decodeNpmPackumentJson = Schema.decodeEffect(Schema.fromJsonString(NpmPackumentResponse));

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
  function* (input: Parameters<PackageManagerReleaseAge["getCutoffMs"]>[0]) {
    switch (input.lockKey) {
      case NPM_GLOBAL_UPDATE_LOCK_KEY: {
        const configArgs = input.npmPrefix ? ["--global", "--prefix", input.npmPrefix] : [];
        const before = yield* execFileUtf8("npm", ["config", "get", "before", ...configArgs], {
          env: input.env,
        });
        const beforeMs = before ? parseNpmBeforeConfigValue(before) : null;
        if (beforeMs !== null) {
          return beforeMs;
        }
        const minReleaseAge = yield* execFileUtf8(
          "npm",
          ["config", "get", "min-release-age", ...configArgs],
          { env: input.env },
        );
        const days = minReleaseAge ? parseNonNegativeNumber(minReleaseAge) : null;
        return days === null ? null : cutoffFromAge(input.nowMs, days * 24 * 60 * 60 * 1_000);
      }

      case BUN_GLOBAL_UPDATE_LOCK_KEY: {
        const stdout = yield* execFileUtf8("bun", ["-e", BUN_MINIMUM_RELEASE_AGE_SCRIPT], {
          env: input.env,
        });
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
)(function* (input: Parameters<PackageManagerReleaseAge["getCutoffMs"]>[0]) {
  const cache = yield* PackageManagerReleaseAgeCutoffCache;
  const key = [
    input.lockKey,
    input.npmPrefix ?? "",
    ...Object.entries(input.env ?? {})
      .toSorted(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, value]) => [name, value === undefined ? "-" : `+${value}`]),
  ].join("\0");
  const cached = cache.get(key);
  if (cached && cached.expiresAt > input.nowMs) {
    return cached.beforeMs;
  }
  const beforeMs = yield* readLivePackageManagerReleaseAgeCutoff(input);
  cache.set(key, {
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

const MiseOutdatedTool = Schema.Struct({
  latest: Schema.String,
});

const MiseOutdatedResponse = Schema.Record(Schema.String, MiseOutdatedTool);

const decodeMiseOutdatedResponse = Schema.decodeEffect(Schema.fromJsonString(MiseOutdatedResponse));

export const parseMiseOutdatedLatestVersion = Effect.fn("parseMiseOutdatedLatestVersion")(
  function* (input: {
    readonly stdout: string;
    readonly toolName: string;
    readonly currentVersion?: string | null;
  }) {
    const outdated = yield* decodeMiseOutdatedResponse(input.stdout);
    const entry = outdated[input.toolName];
    return (
      entry?.latest ?? (Object.keys(outdated).length === 0 ? (input.currentVersion ?? null) : null)
    );
  },
);

// mise owns a provider binary when `mise which` resolves it and the owning
// configured tool's install dir contains it. The longest matching install dir
// wins so backend-flattened names like npm:@xai-official/grok still map back.
const readLiveMiseCommandResolution = Effect.fn("readLiveMiseCommandResolution")(function* (input: {
  readonly binaryName: string;
  readonly packageName: string;
  readonly commandPaths: ReadonlyArray<string>;
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
  const fromShim = input.commandPaths.some((path) =>
    normalizeCommandPath(path).includes("/mise/shims/"),
  );
  if (
    !fromShim &&
    !input.commandPaths.some(
      (path) => normalizeCommandPath(path) === normalizeCommandPath(realWhichPath),
    )
  ) {
    return { commandPath: null, toolName: null };
  }
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
      const realInstallPath = yield* fileSystem
        .realPath(installPath)
        .pipe(Effect.orElseSucceed(() => installPath));
      const normalizedInstallPath = normalizeCommandPath(realInstallPath);
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

export function makeProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
  readonly updateCommand?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly latestVersion?: string | null;
  readonly lookupLatestVersion?: Effect.Effect<string | null>;
}): ProviderMaintenanceCapabilities {
  const platform = input.platform ?? HostProcess.Platform.defaultValue();
  const update =
    input.updateExecutable === null || input.updateLockKey === null
      ? null
      : {
          command:
            input.updateCommand ??
            [
              quoteUpdateExecutable(input.updateExecutable, platform),
              ...input.updateArgs.map((arg) => quoteShellWord(arg, platform)),
            ].join(" "),
          executable: input.updateExecutable,
          args: input.updateArgs,
          lockKey: input.updateLockKey,
          ...(input.env ? { env: input.env } : {}),
        };
  return {
    provider: input.provider,
    packageName: input.packageName,
    update,
    ...("latestVersion" in input ? { latestVersion: input.latestVersion } : {}),
    ...(input.lookupLatestVersion ? { lookupLatestVersion: input.lookupLatestVersion } : {}),
  };
}

export function makeTargetedProviderUpdateAction(
  capabilities: ProviderMaintenanceCapabilities,
  version: string,
): ProviderMaintenanceCommandAction | null {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const update = capabilities.update;
  const packageName = capabilities.packageName;
  if (!update || !packageName) return null;
  if (
    !/^(?:npm-global:|bun-global$|pnpm-global$|vite-plus-global$|yarn-global$|volta$)/.test(
      update.lockKey,
    )
  )
    return null;
  const packageIndex = update.args.findIndex(
    (arg) => arg === `${packageName}@latest` || arg === packageName,
  );
  if (packageIndex < 0) return null;
  const args = update.args.map((arg, index) =>
    index === packageIndex ? `${packageName}@${version}` : arg,
  );
  const previous = update.args[packageIndex]!;
  const commandIndex = update.command.lastIndexOf(previous);
  const command =
    commandIndex < 0
      ? update.command
      : `${update.command.slice(0, commandIndex)}${packageName}@${version}${update.command.slice(commandIndex + previous.length)}`;
  return { ...update, args, command };
}

// pnpm 11 resolves `@latest` to the newest release older than `minimumReleaseAge`
// and exits 0, so a release advertised from the npm dist-tag would never install.
// An exact spec installs it and pnpm records it in `minimumReleaseAgeExclude`.
export function resolveLatestProviderUpdateAction(
  capabilities: ProviderMaintenanceCapabilities,
  latestVersion: string | null,
): ProviderMaintenanceCommandAction | null {
  const update = capabilities.update;
  if (update?.lockKey !== "pnpm-global" || latestVersion === null) return update;
  return makeTargetedProviderUpdateAction(capabilities, latestVersion) ?? update;
}

export function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly installPath?: string;
  readonly lookupLatestVersion?: Effect.Effect<string | null>;
  readonly manualCommand?: string;
}): ProviderMaintenanceCapabilities {
  return {
    ...makeProviderMaintenanceCapabilities({
      provider: input.provider,
      packageName: input.packageName,
      updateExecutable: null,
      updateArgs: [],
      updateLockKey: null,
      ...(input.lookupLatestVersion
        ? { latestVersion: null, lookupLatestVersion: input.lookupLatestVersion }
        : {}),
    }),
    ...(input.installPath ? { installPath: input.installPath } : {}),
    ...(input.manualCommand ? { manualCommand: input.manualCommand } : {}),
  };
}

export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

/**
 * Vite+ shims live in `<VP_HOME>/bin`: `~/.vite-plus` by default,
 * `~/.local/share/vite-plus` with the XDG layout, and `%LOCALAPPDATA%\vite-plus`
 * on Windows.
 */
function isVitePlusGlobalCommandPath(commandPath: string): boolean {
  return /\/(?:\.vite-plus|\.local\/share\/vite-plus|appdata\/local\/vite-plus)\/bin\//.test(
    normalizeCommandPath(commandPath),
  );
}

function isBunGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.bun/bin/");
}

function isYarnGlobalCommandPath(commandPath: string): boolean {
  return /\/yarn\/(?:data\/)?global\/node_modules\//.test(normalizeCommandPath(commandPath));
}

/**
 * Version-manager installs are pinned in its config, so updating them means editing that.
 * A command wrapper is a symlink to the `mise` binary, which dispatches on argv[0].
 */
function isMiseCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/mise/installs/") ||
    normalized.includes("/mise/shims/") ||
    normalized.includes("/mise/command-wrappers/") ||
    /\/mise(?:\.exe)?$/.test(normalized)
  );
}

const winGetClaudeCommandPath =
  /^[a-z]:\/(?:users\/[^/]+\/appdata\/local\/microsoft|program files(?: \(x86\))?)\/winget\/(?:links|packages\/anthropic\.claudecode_[^/]+)\/claude\.exe$/;

function isWinGetClaudeCommandPath(commandPath: string): boolean {
  return winGetClaudeCommandPath.test(normalizeCommandPath(commandPath));
}

const CHOCOLATEY_CLAUDE_PACKAGE_ID = "claude-code";

// Chocolatey's executable shim is not a symlink, so realpath cannot prove its owner.
const chocolateyClaudeCommandPath = /\/chocolatey\/(?:bin|lib\/claude-code\/tools)\/claude\.exe$/;

function isChocolateyClaudeCommandPath(commandPath: string, env: NodeJS.ProcessEnv): boolean {
  const normalized = normalizeCommandPath(commandPath);
  if (chocolateyClaudeCommandPath.test(normalized)) return true;
  const root = nonEmptyString(env.ChocolateyInstall);
  if (!root) return false;
  const prefix = normalizeCommandPath(root.replace(/[\\/]+$/, ""));
  return (
    normalized === `${prefix}/bin/claude.exe` ||
    normalized === `${prefix}/lib/claude-code/tools/claude.exe`
  );
}

/** `choco search --exact --limit-output` prints `<id>|<version>` for a match and nothing otherwise. */
export function parseChocolateyLatestVersion(output: string, packageId: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const [id, version] = line.trim().split("|", 2);
    if (id?.toLowerCase() === packageId.toLowerCase()) return nonEmptyString(version);
  }
  return null;
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

export function npmGlobalPrefixFromCommandPath(
  realCommandPath: string,
  packageName: string,
): string | null {
  const slashPath = realCommandPath.replaceAll("\\", "/");
  const normalized = slashPath.toLowerCase();
  const packageSegment = `/lib/node_modules/${packageName.toLowerCase()}/`;
  const packageIndex = normalized.lastIndexOf(packageSegment);
  if (packageIndex < 0 || normalized.slice(0, packageIndex).includes("/node_modules/")) {
    return null;
  }
  // Mise tool layouts resemble npm globals; only globals under its Node install belong to npm.
  const miseTool = /\/mise\/installs\/([^/]+)\/[^/]+$/.exec(normalized.slice(0, packageIndex))?.[1];
  if (miseTool && miseTool !== "node") {
    return null;
  }
  return packageIndex === 0 ? "/" : slashPath.slice(0, packageIndex);
}

const HOMEBREW_KEG_PATTERN = /^(.*)\/(cellar|caskroom)\/([^/]+)\/[^/]+\//i;

export interface HomebrewOwnership {
  readonly kind: "formula" | "cask";
  readonly name: string;
  readonly prefix: string;
}

export function homebrewOwnershipFromCommandPath(
  realCommandPath: string,
): HomebrewOwnership | null {
  const match = HOMEBREW_KEG_PATTERN.exec(realCommandPath.replaceAll("\\", "/"));
  if (!match) {
    return null;
  }
  return {
    kind: match[2]!.toLowerCase() === "cellar" ? "formula" : "cask",
    name: match[3]!,
    prefix: match[1]!,
  };
}

const HomebrewInfoResponse = Schema.Struct({
  formulae: Schema.optional(
    Schema.Array(
      Schema.Struct({
        versions: Schema.optional(Schema.Struct({ stable: Schema.optional(Schema.String) })),
      }),
    ),
  ),
  casks: Schema.optional(Schema.Array(Schema.Struct({ version: Schema.optional(Schema.String) }))),
});

const decodeHomebrewInfo = Schema.decodeUnknownOption(Schema.fromJsonString(HomebrewInfoResponse));

export function parseHomebrewLatestVersion(
  infoJson: string,
  ownership: HomebrewOwnership,
): string | null {
  const decoded = decodeHomebrewInfo(infoJson);
  if (Option.isNone(decoded)) {
    return null;
  }
  const raw =
    ownership.kind === "formula"
      ? decoded.value.formulae?.[0]?.versions?.stable
      : decoded.value.casks?.[0]?.version?.split(",", 1)[0];
  const version = nonEmptyString(raw);
  return version === "latest" ? null : version;
}

export const runProbe = Effect.fn("runProbe")(function* (
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  okExitCodes: ReadonlyArray<number> = [0],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const collect = Effect.gen(function* () {
    // Windows package managers are `.cmd` shims that need the shell.
    const resolved = yield* resolveSpawnCommand(command, args, { env, extendEnv: true });
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        env,
        extendEnv: true,
        shell: resolved.shell,
      }),
    );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    // stderr is drained so a chatty tool cannot block on a full pipe.
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: PROBE_MAX_BYTES }),
        child.exitCode,
        Stream.runDrain(child.stderr),
      ],
      { concurrency: "unbounded" },
    );
    return !okExitCodes.includes(Number(exitCode)) || stdout.truncated ? null : stdout.text;
  });
  return yield* collect.pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(PROBE_TIMEOUT_MS)),
    Effect.map(Option.getOrNull),
    Effect.catchCause((cause) =>
      Effect.logWarning("Maintenance probe failed", {
        command,
        subcommand: args[0],
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as(null)),
    ),
  );
});

const decodePnpmOutdated = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Struct({ latest: Schema.optional(Schema.String) })),
  ),
);
const decodePnpmList = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        dependencies: Schema.optional(
          Schema.Record(Schema.String, Schema.Struct({ version: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
);

// Unlike npm's latest tag, pnpm outdated respects minimumReleaseAge and its excludes.
const resolvePnpmGlobalLatestVersion = Effect.fn("resolvePnpmGlobalLatestVersion")(function* (
  packageName: string,
  env: NodeJS.ProcessEnv,
) {
  // Match the updater's pnpm and environment.
  const pnpmPath = yield* resolveCommandPath("pnpm", {
    env: { ...(yield* HostProcess.Environment), ...env },
  });
  if (!pnpmPath) return null;
  // Silent reporting keeps project package-manager warnings out of the JSON.
  const outdated = yield* runProbe(
    pnpmPath,
    ["outdated", "-g", "--reporter=silent", "--format", "json", packageName],
    env,
    // pnpm outdated exits 1 when updates are available.
    [0, 1],
  );
  const outdatedEntries = outdated
    ? Option.getOrUndefined(decodePnpmOutdated(outdated))
    : undefined;
  if (!outdatedEntries) return null;
  const latest = nonEmptyString(outdatedEntries[packageName]?.latest);
  if (latest) return latest;
  // An empty result means the installed version is still the eligible release.
  const listed = yield* runProbe(
    pnpmPath,
    ["ls", "-g", "--reporter=silent", "--depth", "0", "--json", packageName],
    env,
  );
  const listedEntries = listed ? Option.getOrUndefined(decodePnpmList(listed)) : undefined;
  return nonEmptyString(listedEntries?.[0]?.dependencies?.[packageName]?.version);
});

export const resolvePackageManagedProviderMaintenance = Effect.fn(
  "resolvePackageManagedProviderMaintenance",
)(function* (
  definition: PackageManagedProviderMaintenanceDefinition,
  context: ProviderMaintenanceResolutionContext | null,
) {
  if (!context) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
    });
  }
  const manual = makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    installPath: context.realCommandPath,
  });
  if ([context.resolvedCommandPath, context.realCommandPath].some(isMiseCommandPath)) {
    const binaryName = context.binaryPath.split(/[\\/]/).pop() ?? context.binaryPath;
    const owned = yield* readLiveMiseCommandResolution({
      binaryName,
      packageName: definition.npmPackageName,
      commandPaths: [context.resolvedCommandPath, context.realCommandPath],
      env: context.env,
    });
    if (owned.toolName) {
      return {
        ...makeProviderMaintenanceCapabilities({
          provider: definition.provider,
          packageName: definition.npmPackageName,
          updateExecutable: "mise",
          updateArgs: ["upgrade", owned.toolName],
          updateLockKey: MISE_UPDATE_LOCK_KEY,
          env: context.env,
        }),
        managedLatest: {
          executable: "mise",
          args: ["outdated", "--json", owned.toolName],
          toolName: owned.toolName,
        },
      };
    }
    // A shim can expose a global package installed under mise's Node runtime.
    if (owned.commandPath) {
      context = {
        ...context,
        resolvedCommandPath: owned.commandPath,
        realCommandPath: owned.commandPath,
      };
    }
  }
  const commandPaths = [context.resolvedCommandPath, context.realCommandPath];
  const packageName = definition.npmPackageName;
  // WinGet-managed claude update exits 0 without updating; T3 does not run winget upgrade.
  if (
    definition.provider === "claudeAgent" &&
    context.platform === "win32" &&
    commandPaths.some(isWinGetClaudeCommandPath)
  ) {
    return manual;
  }
  // Chocolatey's package directory is writable only by administrators, so an
  // unelevated server cannot run `choco upgrade`; `claude update` through the
  // shim installs a native copy elsewhere and leaves the shim's version alone.
  if (
    definition.provider === "claudeAgent" &&
    context.platform === "win32" &&
    commandPaths.some((commandPath) => isChocolateyClaudeCommandPath(commandPath, context.env))
  ) {
    const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      installPath: context.realCommandPath,
      manualCommand: "choco upgrade claude-code",
      lookupLatestVersion: runProbe(
        "choco",
        ["search", CHOCOLATEY_CLAUDE_PACKAGE_ID, "--exact", "--limit-output"],
        context.env,
      ).pipe(
        Effect.map((output) =>
          output ? parseChocolateyLatestVersion(output, CHOCOLATEY_CLAUDE_PACKAGE_ID) : null,
        ),
        Effect.provideContext(services),
      ),
    });
  }

  const nativeUpdate = definition.nativeUpdate;
  const nativeEnv = nativeUpdate?.env;
  const native = nativeUpdate
    ? makeProviderMaintenanceCapabilities({
        provider: definition.provider,
        packageName,
        updateExecutable: context.resolvedCommandPath,
        updateArgs: nativeUpdate.args,
        updateLockKey: `${definition.provider}-native`,
        platform: context.platform,
        ...(nativeEnv
          ? { env: typeof nativeEnv === "function" ? nativeEnv(context) : nativeEnv }
          : {}),
      })
    : manual;
  // A native-looking launcher can still delegate to an npm- or mise-owned install.
  if (
    nativeUpdate?.isCommandPath &&
    commandPaths.some(nativeUpdate.isCommandPath) &&
    !npmGlobalPrefixFromCommandPath(context.realCommandPath, packageName) &&
    !commandPaths.some(isMiseCommandPath) &&
    !(yield* isMiseWrapperScript(context))
  ) {
    return native;
  }
  // A `node_modules` path not proven below belongs to another package or a
  // project, so the provider's own updater could act on the wrong install.
  const fallback =
    nativeUpdate?.requiresCommandPath ||
    commandPaths.some((commandPath) => normalizeCommandPath(commandPath).includes("/node_modules/"))
      ? manual
      : native;
  if (commandPaths.some(isVitePlusGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "vp",
      updateArgs: ["i", "-g", packageName],
      updateLockKey: "vite-plus-global",
      env: context.env,
    });
  }
  if (commandPaths.some(isBunGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "bun",
      updateArgs: ["i", "-g", `${packageName}@latest`],
      updateLockKey: "bun-global",
      env: context.env,
    });
  }
  if (commandPaths.some(isPnpmGlobalCommandPath)) {
    // pnpm 10 skips unapproved scripts; the approval flag requires 10.4+.
    const pnpmVersion = yield* runProbe("pnpm", ["--version"], context.env);
    const allowBuild =
      pnpmVersion !== null && satisfiesSemverRange(pnpmVersion, ">=10.4.0")
        ? [`--allow-build=${packageName}`]
        : [];
    const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "pnpm",
      updateArgs: ["add", "-g", ...allowBuild, `${packageName}@latest`],
      updateLockKey: "pnpm-global",
      env: context.env,
      lookupLatestVersion: resolvePnpmGlobalLatestVersion(packageName, context.env).pipe(
        Effect.provideContext(services),
      ),
    });
  }

  if (commandPaths.some(isYarnGlobalCommandPath)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "yarn",
      updateArgs: ["global", "add", `${packageName}@latest`],
      updateLockKey: "yarn-global",
      env: context.env,
    });
  }
  if (yield* isVoltaPackageInstall(context, packageName)) {
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "volta",
      updateArgs: ["install", `${packageName}@latest`],
      updateLockKey: "volta",
      env: context.env,
    });
  }

  // npm proof outranks a containing Homebrew keg; Homebrew Node globals still belong to npm.
  const npmPrefix = yield* resolveNpmGlobalPrefix(context, packageName);
  if (npmPrefix) {
    // npm 12 requires script approval to install native binaries; older npm only warns about the flag.
    return makeProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName,
      updateExecutable: "npm",
      updateArgs: [
        "install",
        "-g",
        "--prefix",
        npmPrefix,
        `--allow-scripts=${packageName}`,
        `${packageName}@latest`,
      ],
      updateLockKey: `npm-global:${normalizeCommandPath(npmPrefix)}`,
      env: context.env,
    });
  }

  const homebrew = homebrewOwnershipFromCommandPath(context.realCommandPath);
  if (
    commandPaths.some(isMiseCommandPath) ||
    // Mise shims resolve to the version manager's keg, not the provider's.
    (homebrew?.kind === "formula" && homebrew.name.toLowerCase() === "mise") ||
    (yield* isMiseWrapperScript(context))
  ) {
    return manual;
  }
  if (homebrew) {
    return (
      (yield* resolveHomebrewProviderMaintenance(
        { provider: definition.provider, packageName },
        homebrew,
        context,
      )) ?? fallback
    );
  }

  return fallback;
});

/**
 * `brew upgrade` capabilities once the keg's prefix is confirmed by a `brew`
 * that reports it as its own. Version checks defer `brew info` until needed.
 * Null when no `brew` is found or it owns another prefix.
 */
export const resolveHomebrewProviderMaintenance = Effect.fn("resolveHomebrewProviderMaintenance")(
  function* (
    input: { readonly provider: ProviderDriverKind; readonly packageName: string | null },
    homebrew: HomebrewOwnership,
    context: ProviderMaintenanceResolutionContext,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // GUI servers may lack Homebrew on PATH; use the keg brew with the same prefix check.
    const kegBrewPath = path.join(homebrew.prefix, "bin", "brew");
    const brewPath = (yield* fileSystem.exists(kegBrewPath).pipe(Effect.orElseSucceed(() => false)))
      ? kegBrewPath
      : yield* resolveCommandPath("brew", { env: context.env });
    if (!brewPath) {
      return null;
    }
    const brewPrefix = nonEmptyString(yield* runProbe(brewPath, ["--prefix"], context.env));
    const realBrewPrefix = brewPrefix
      ? yield* fileSystem.realPath(brewPrefix).pipe(Effect.orElseSucceed(() => brewPrefix))
      : null;
    if (
      !realBrewPrefix ||
      normalizeCommandPath(realBrewPrefix) !== normalizeCommandPath(homebrew.prefix)
    ) {
      return null;
    }
    const args =
      homebrew.kind === "cask" ? ["upgrade", "--cask", homebrew.name] : ["upgrade", homebrew.name];
    const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
    return makeProviderMaintenanceCapabilities({
      provider: input.provider,
      packageName: input.packageName,
      updateExecutable: brewPath,
      updateArgs: args,
      updateLockKey: "homebrew",
      updateCommand: ["brew", ...args].join(" "),
      // Brew's release can lag npm; only its own channel can say what upgrade installs.
      latestVersion: null,
      lookupLatestVersion: runProbe(
        brewPath,
        ["info", "--json=v2", homebrew.name],
        context.env,
      ).pipe(
        Effect.map((info) => (info ? parseHomebrewLatestVersion(info, homebrew) : null)),
        Effect.provideContext(services),
      ),
    });
  },
);

const isMiseWrapperScript = Effect.fn("isMiseWrapperScript")(function* (
  context: ProviderMaintenanceResolutionContext,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const size = yield* fileSystem.stat(context.realCommandPath).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => Infinity),
  );
  if (size > MISE_WRAPPER_MAX_BYTES) {
    return false;
  }
  const script = yield* fileSystem
    .readFileString(context.realCommandPath)
    .pipe(Effect.orElseSucceed(() => ""));
  return script.startsWith("#!") && /\bmise\s+(?:x|exec)\b/.test(script);
});

// Volta bin links only identify its shim; the package image proves ownership.
const isVoltaPackageInstall = Effect.fn("isVoltaPackageInstall")(function* (
  context: ProviderMaintenanceResolutionContext,
  packageName: string,
) {
  const path = yield* Path.Path;
  if (
    path.basename(normalizeCommandPath(context.realCommandPath)).replace(/\.exe$/, "") !==
    "volta-shim"
  ) {
    return false;
  }
  const voltaHome = path.dirname(path.dirname(context.resolvedCommandPath));
  const packageDir = path.join(voltaHome, "tools", "image", "packages", ...packageName.split("/"));
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.exists(packageDir).pipe(Effect.orElseSucceed(() => false));
});

const resolveNpmGlobalPrefix = Effect.fn("resolveNpmGlobalPrefix")(function* (
  context: ProviderMaintenanceResolutionContext,
  packageName: string,
) {
  const fromRealPath = npmGlobalPrefixFromCommandPath(context.realCommandPath, packageName);
  if (fromRealPath) {
    return fromRealPath;
  }
  if ((yield* HostProcess.Platform) !== "win32") {
    return null;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shimDir = path.dirname(context.resolvedCommandPath);
  const manifestPath = path.join(
    shimDir,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  // Windows npm shims sit beside node_modules; POSIX project checkouts can mimic this layout.
  const hasManifest = yield* fileSystem
    .exists(manifestPath)
    .pipe(Effect.orElseSucceed(() => false));
  return hasManifest ? shimDir : null;
});

export function makePackageManagedProviderMaintenanceResolver(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: (context) => resolvePackageManagedProviderMaintenance(definition, context),
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

const decodeNpmViewVersion = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([Schema.String, Schema.Tuple([Schema.String])])),
);

const withConfiguredNpmVersionLookup = Effect.fn("withConfiguredNpmVersionLookup")(function* (
  capabilities: ProviderMaintenanceCapabilities,
) {
  const packageName = capabilities.packageName;
  if (!packageName || capabilities.latestVersion !== undefined) {
    return capabilities;
  }
  const env = { ...(yield* HostProcess.Environment), ...capabilities.update?.env };
  const npmPath = yield* resolveCommandPath("npm", { env });
  if (!npmPath) return capabilities;
  const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
  const update = capabilities.update;
  const prefixIndex = update?.lockKey.startsWith("npm-global:")
    ? update.args.indexOf("--prefix")
    : -1;
  const prefix = prefixIndex >= 0 ? update?.args[prefixIndex + 1] : undefined;
  const lookupRegistryVersion = Effect.fn("lookupConfiguredRegistryVersion")(function* (
    beforeMs: number | null,
  ) {
    const stdout = yield* runProbe(
      npmPath,
      [
        "view",
        "--global",
        ...(prefix ? ["--prefix", prefix] : []),
        "--json",
        ...(beforeMs === null
          ? [`${packageName}@latest`, "version"]
          : [packageName, "time", "dist-tags"]),
      ],
      env,
    );
    if (!stdout) return null;
    if (beforeMs === null) {
      const value = Option.getOrNull(decodeNpmViewVersion(stdout.trim()));
      return nonEmptyString(typeof value === "string" ? value : value?.[0]);
    }
    const payload = yield* decodeNpmPackumentJson(stdout).pipe(Effect.orElseSucceed(() => null));
    return payload
      ? pickInstallableLatest({
          distTagLatest: nonEmptyString(payload["dist-tags"]?.latest),
          times: payload.time ?? {},
          beforeMs,
        })
      : null;
  }, Effect.provideContext(services));
  const lookup = lookupRegistryVersion(null).pipe(
    Effect.tap((version) =>
      version === null
        ? Effect.logWarning("Configured npm version lookup failed", { packageName })
        : Effect.void,
    ),
  );
  return {
    ...capabilities,
    // npm owns registry, scoped auth and proxy configuration; failure must not retry public npm.
    latestVersion: null,
    lookupRegistryVersion,
    lookupLatestVersion: capabilities.lookupLatestVersion
      ? capabilities.lookupLatestVersion.pipe(
          Effect.filterOrElse(
            (version) => version !== null,
            () => lookup,
          ),
        )
      : lookup,
  };
});

export const resolveProviderMaintenanceCapabilitiesEffect = Effect.fn(
  "resolveProviderMaintenanceCapabilitiesEffect",
)(function* (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  options?: {
    readonly binaryPath?: string | null;
    readonly env?: NodeJS.ProcessEnv;
  },
) {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return yield* resolver.resolve(null);
  }

  const env = options?.env ?? (yield* readCommandLookupEnv);
  const resolvedCommandPath = yield* resolveCommandPath(binaryPath, { env });
  if (!resolvedCommandPath) {
    return yield* resolver.resolve(null);
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const realCommandPath = yield* fileSystem
    .realPath(resolvedCommandPath)
    .pipe(Effect.orElseSucceed(() => null));
  if (!realCommandPath) {
    return yield* resolver.resolve(null);
  }
  return yield* resolver.resolve({
    binaryPath,
    resolvedCommandPath,
    realCommandPath,
    env,
    platform: yield* HostProcess.Platform,
  });
}, Effect.flatMap(withConfiguredNpmVersionLookup));

export const makeCachedProviderMaintenanceResolution = Effect.fn(
  "makeCachedProviderMaintenanceResolution",
)(function* (resolve: Effect.Effect<ProviderMaintenanceCapabilities>) {
  const cache = yield* Cache.make({
    capacity: 1,
    timeToLive: MAINTENANCE_CAPABILITIES_CACHE_TTL,
    lookup: () => resolve,
  });
  const cached = Cache.get(cache, undefined);
  return (options?: { readonly fresh?: boolean }) =>
    options?.fresh ? Cache.invalidate(cache, undefined).pipe(Effect.andThen(cached)) : cached;
});

function manualUpdateMessage(latestVersion: string, installPath: string | undefined): string {
  return installPath
    ? `Version ${latestVersion} is out. T3 Code runs ${installPath}; update it with the app or tool that installed it.`
    : `Version ${latestVersion} is out. Update it with the app or tool that installed it.`;
}

function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly capabilities: ProviderMaintenanceCapabilities;
}): Pick<ServerProviderVersionAdvisory, "status" | "message"> {
  if (!input.currentVersion) {
    return { status: "unknown", message: null };
  }
  if (!input.latestVersion) {
    return { status: "unknown", message: null };
  }
  if (
    (input.capabilities.compareVersions ?? compareSemverVersions)(
      input.currentVersion,
      input.latestVersion,
    ) < 0
  ) {
    return {
      status: "behind_latest",
      message:
        input.capabilities.update === null
          ? manualUpdateMessage(input.latestVersion, input.capabilities.installPath)
          : PROVIDER_UPDATE_ACTION_TOAST_MESSAGE,
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
    capabilities,
  });

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand:
      resolveLatestProviderUpdateAction(capabilities, latestVersion)?.command ??
      capabilities.manualCommand ??
      null,
    canUpdate: capabilities.update !== null,
    canInstallVersion: makeTargetedProviderUpdateAction(capabilities, "0.0.0") !== null,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
  };
}

const fetchRegistryJson = Effect.fn("fetchRegistryJson")(function* (path: string) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(`https://registry.npmjs.org/${path}`).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
  );
  // The deadline includes the response body, which can stall after headers arrive.
  return yield* client.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
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

/**
 * The installer's own answer is cached apart from the npm registry entry. A
 * manual-only install has no command to key on, so its executable stands in.
 */
function installerLatestVersionKey(capabilities: ProviderMaintenanceCapabilities) {
  if (!capabilities.lookupLatestVersion) return null;
  if (capabilities.latestVersionCacheKey) return capabilities.latestVersionCacheKey;
  const update = capabilities.update;
  if (update) return [update.lockKey, update.executable, ...update.args].join("\0");
  return capabilities.installPath
    ? ["manual", capabilities.installPath].join("\0")
    : capabilities.packageName && `npm-registry\0${capabilities.packageName}`;
}

export function latestProviderVersionCacheKeys(
  capabilities: ProviderMaintenanceCapabilities,
): ReadonlyArray<string> {
  return [capabilities.packageName, installerLatestVersionKey(capabilities)].filter(
    (key) => key !== null,
  );
}
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
    readonly currentVersion?: string | null;
    readonly respectPackageManagerReleaseAge?: boolean;
  },
) {
  const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
  const packageName = maintenanceCapabilities.packageName;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const managedLatest =
    options?.respectPackageManagerReleaseAge === false
      ? null
      : maintenanceCapabilities.managedLatest;
  if (managedLatest && packageName) {
    const cacheKey = `${packageName}@managed:${[managedLatest.executable, ...managedLatest.args].join(" ")}`;
    return yield* latestVersions.cached(
      cacheKey,
      Effect.gen(function* () {
        const env = { ...(yield* readCommandLookupEnv), ...maintenanceCapabilities.update?.env };
        const stdout = yield* execFileUtf8(managedLatest.executable, [...managedLatest.args], {
          timeoutMs: MANAGED_LATEST_TIMEOUT_MS,
          env,
        });
        return yield* parseMiseOutdatedLatestVersion({
          stdout: stdout ?? "",
          toolName: managedLatest.toolName,
          currentVersion: options?.currentVersion ?? null,
        }).pipe(Effect.orElseSucceed(() => null));
      }),
    );
  }
  const updateLockKey = maintenanceCapabilities.update?.lockKey ?? null;
  const lockKey = updateLockKey?.startsWith("npm-global:")
    ? NPM_GLOBAL_UPDATE_LOCK_KEY
    : updateLockKey;
  const update = maintenanceCapabilities.update;
  const prefixIndex = updateLockKey?.startsWith("npm-global:")
    ? update?.args.indexOf("--prefix")
    : undefined;
  const npmPrefix =
    prefixIndex !== undefined && prefixIndex >= 0 ? update?.args[prefixIndex + 1] : undefined;
  const cutoffMs =
    options?.respectPackageManagerReleaseAge !== false && lockKey
      ? yield* (yield* PackageManagerReleaseAge).getCutoffMs({
          lockKey,
          nowMs: now,
          env: update?.env,
          npmPrefix,
        })
      : null;
  const registryLookup = maintenanceCapabilities.lookupRegistryVersion;
  const bypassInstaller =
    options?.respectPackageManagerReleaseAge === false &&
    maintenanceCapabilities.update?.lockKey === "pnpm-global";
  if (registryLookup && (cutoffMs !== null || bypassInstaller)) {
    const key = `${installerLatestVersionKey(maintenanceCapabilities)}@before:${cutoffMs}`;
    return yield* latestVersions.cached(key, registryLookup(cutoffMs));
  }
  const installerKey = installerLatestVersionKey(maintenanceCapabilities);
  const pnpmPolicy = maintenanceCapabilities.update?.lockKey === "pnpm-global";
  if (
    installerKey &&
    maintenanceCapabilities.lookupLatestVersion &&
    (!pnpmPolicy || options?.respectPackageManagerReleaseAge !== false)
  ) {
    const installable = yield* latestVersions.cached(
      installerKey,
      maintenanceCapabilities.lookupLatestVersion,
    );
    if (installable !== null) return installable;
  }
  if (maintenanceCapabilities.latestVersion !== undefined) {
    return maintenanceCapabilities.latestVersion;
  }
  if (!packageName) {
    return null;
  }

  const cacheKey = cutoffMs === null ? packageName : `${packageName}@before:${cutoffMs}`;
  return yield* latestVersions.cached(
    cacheKey,
    cutoffMs === null
      ? fetchNpmLatestVersion(packageName)
      : fetchNpmInstallableLatestVersion(packageName, cutoffMs),
  );
});

export const invalidateLatestProviderVersion = Effect.fn("invalidateLatestProviderVersion")(
  function* (maintenanceCapabilities: ProviderMaintenanceCapabilities) {
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    yield* Effect.forEach(
      latestProviderVersionCacheKeys(maintenanceCapabilities),
      latestVersions.invalidate,
      { discard: true },
    );
  },
);

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
  const currentVersion =
    snapshot.installedVersion !== undefined ? snapshot.installedVersion : snapshot.version;
  const shouldResolveLatestVersion =
    options?.enableProviderUpdateChecks !== false &&
    snapshot.enabled &&
    snapshot.installed &&
    Boolean(currentVersion);
  if (!shouldResolveLatestVersion) {
    return {
      ...snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: snapshot.driver,
        currentVersion,
        checkedAt: snapshot.checkedAt,
        maintenanceCapabilities: capabilities,
      }),
    };
  }

  const latestVersionOptions =
    options?.respectPackageManagerReleaseAge === undefined
      ? { currentVersion }
      : {
          currentVersion,
          respectPackageManagerReleaseAge: options.respectPackageManagerReleaseAge,
        };
  const latestVersion = yield* resolveLatestProviderVersion(capabilities, latestVersionOptions);
  return {
    ...snapshot,
    versionAdvisory: createProviderVersionAdvisory({
      driver: snapshot.driver,
      currentVersion,
      latestVersion,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      maintenanceCapabilities: capabilities,
    }),
  };
});
