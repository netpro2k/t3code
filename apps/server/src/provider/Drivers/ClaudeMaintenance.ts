import { ProviderDriverKind } from "@t3tools/contracts";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
  runProbe,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceResolverServices,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const NATIVE_RELEASES = "https://downloads.claude.ai/claude-code-releases";
const NativeVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/));

const update = makePackageManagedProviderMaintenanceResolver({
  provider: ProviderDriverKind.make("claudeAgent"),
  npmPackageName: "@anthropic-ai/claude-code",
  mise: { tool: "claude" },
  nativeUpdate: {
    args: ["update"],
    isCommandPath: (commandPath) => {
      const normalized = normalizeCommandPath(commandPath);
      return (
        normalized.endsWith("/.local/bin/claude") ||
        normalized.endsWith("/.local/bin/claude.exe") ||
        normalized.includes("/.local/share/claude/")
      );
    },
  },
});

const resolveClaudeMaintenance = Effect.fn("ClaudeMaintenance.resolve")(function* (
  capabilities: ProviderMaintenanceCapabilities,
  env: NodeJS.ProcessEnv,
) {
  const action = capabilities.update;
  if (action?.lockKey !== "claudeAgent-native") return capabilities;
  const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
  const client = yield* HttpClient.HttpClient;
  return {
    ...capabilities,
    update: { ...action, env },
    latestVersion: null,
    latestVersionCacheKey: [
      action.lockKey,
      action.executable,
      ...action.args,
      env.CLAUDE_CONFIG_DIR ?? "",
      env.HOME ?? "",
    ].join("\0"),
    lookupLatestVersion: runProbe(action.executable, ["doctor"], env).pipe(
      Effect.flatMap((diagnostics) => {
        const channel = /^Auto-update channel: (latest|stable)\s*$/m.exec(diagnostics ?? "")?.[1];
        if (channel === undefined) return Effect.succeed(null);
        return client.get(`${NATIVE_RELEASES}/${channel}`).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
          Effect.map((text) => text.trim()),
          Effect.flatMap(Schema.decodeUnknownEffect(NativeVersion)),
          Effect.timeoutOption("4 seconds"),
          Effect.map(Option.getOrNull),
          Effect.orElseSucceed(() => null),
        );
      }),
      Effect.provideContext(services),
    ),
  };
});

export const makeClaudeMaintenanceResolution = Effect.fn("ClaudeMaintenance.make")(function* (
  options: Parameters<typeof resolveProviderMaintenanceCapabilitiesEffect>[1],
) {
  const services = yield* Effect.context<
    ProviderMaintenanceResolverServices | HttpClient.HttpClient
  >();
  const env = options?.env ?? (yield* HostProcess.Environment);
  const resolveInstallation = yield* makeCachedProviderMaintenanceResolution(
    resolveProviderMaintenanceCapabilitiesEffect(update, options).pipe(
      Effect.provideContext(services),
    ),
  );
  const resolve: typeof resolveInstallation = (refreshOptions) =>
    resolveInstallation(refreshOptions).pipe(
      Effect.flatMap((capabilities) => resolveClaudeMaintenance(capabilities, env)),
      Effect.provideContext(services),
    );
  return resolve;
});
