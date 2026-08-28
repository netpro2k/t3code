// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DESKTOP_LOCAL_SESSION_FILE,
  DesktopLocalSessionJson,
} from "@t3tools/shared/desktopLocalSession";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeSession = Schema.decodeUnknownOption(DesktopLocalSessionJson);

// Run after stopping the service. Never put bearer tokens in argv or updater logs.
export function provisionDesktopSession(serverEntry: string, baseDir: string) {
  const stateDir = join(baseDir, "userdata");
  const sessionPath = join(stateDir, DESKTOP_LOCAL_SESSION_FILE);
  let previous = Option.none<typeof DesktopLocalSessionJson.Type>();
  try {
    previous = decodeSession(readFileSync(sessionPath, "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const runAuth = (args: string[]) => {
    try {
      return execFileSync(
        process.execPath,
        [serverEntry, "auth", "session", ...args, "--base-dir", baseDir],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      // Child-process errors carry stdout, which may contain a token.
      throw new Error("Desktop session provisioning failed: t3 auth session command failed.");
    }
  };
  const issued = decodeSession(
    runAuth([
      "issue",
      "--ttl",
      "30d",
      "--label",
      "T3 Code Desktop",
      "--subject",
      "desktop-local",
      "--json",
    ]),
  );
  if (Option.isNone(issued))
    throw new Error("Desktop session provisioning returned invalid output.");

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(stateDir, ".desktop-session-"));
  try {
    const stagedPath = join(stage, DESKTOP_LOCAL_SESSION_FILE);
    writeFileSync(stagedPath, JSON.stringify(issued.value) + "\n", { mode: 0o600 });
    renameSync(stagedPath, sessionPath);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  if (Option.isSome(previous) && previous.value.sessionId !== issued.value.sessionId) {
    runAuth(["revoke", previous.value.sessionId]);
  }
}

if (import.meta.main) {
  const [serverEntry, baseDir] = process.argv.slice(2);
  if (!serverEntry || !baseDir)
    throw new Error("Usage: provision-desktop-session.ts SERVER_ENTRY T3_HOME");
  provisionDesktopSession(serverEntry, baseDir);
  process.stdout.write(
    "Renewed Desktop's local session for 30 days. Relaunch Desktop to use it.\n",
  );
}
