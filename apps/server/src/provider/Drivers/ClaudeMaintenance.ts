import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { parseSemver } from "@t3tools/shared/semver";
import {
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
  runProbe,
} from "@t3tools/provider-core/server/maintenanceResolver";

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: ProviderDriverKind.make("claudeAgent"),
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export const resolveClaudeMaintenance = Effect.fn("resolveClaudeMaintenance")(function* (input: {
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, input);
  const update = capabilities.update;
  if (update?.lockKey !== "claudeAgent-native") return capabilities;
  const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const httpClient = yield* HttpClient.HttpClient;
  const lookup = runProbe(update.executable, ["doctor"], input.env).pipe(
    Effect.flatMap((diagnostics) => {
      const channel = /^Auto-update channel: (latest|stable)\s*$/m.exec(diagnostics ?? "")?.[1];
      if (channel === undefined) return Effect.succeed(null);
      return httpClient.get(`https://downloads.claude.ai/claude-code-releases/${channel}`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
        Effect.map((body) => {
          const version = body.trim();
          return parseSemver(version) === null ? null : version;
        }),
        Effect.timeout("4 seconds"),
        Effect.orElseSucceed(() => null),
      );
    }),
    Effect.provideContext(services),
  );
  return {
    ...capabilities,
    update: { ...update, env: input.env },
    latestVersion: null,
    latestVersionCacheKey: [input.env.CLAUDE_CONFIG_DIR ?? "", input.env.HOME ?? ""].join("\0"),
    lookupLatestVersion: lookup,
  };
});
