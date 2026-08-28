// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DesktopLocalSessionJson } from "@t3tools/shared/desktopLocalSession";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { provisionDesktopSession } from "./provision-desktop-session.ts";

const serverEntry = fileURLToPath(new URL("../apps/server/src/bin.ts", import.meta.url));
const scriptEntry = fileURLToPath(new URL("./provision-desktop-session.ts", import.meta.url));
const decodeSession = Schema.decodeUnknownSync(DesktopLocalSessionJson);
const encodeSession = Schema.encodeSync(DesktopLocalSessionJson);
const decodeSessions = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        sessionId: Schema.String,
        subject: Schema.String,
      }),
    ),
  ),
);

it.effect("provisions and renews a private 30-day session using the real auth CLI", () =>
  Effect.gen(function* () {
    const baseDir = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "t3-desktop-session-"))),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    );
    const sessionPath = join(baseDir, "userdata/desktop-session.json");
    const before = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const output = execFileSync(process.execPath, [scriptEntry, serverEntry, baseDir], {
      encoding: "utf8",
    });
    const first = decodeSession(readFileSync(sessionPath, "utf8"));
    assert.notInclude(output, first.token);
    assert.equal(statSync(sessionPath).mode & 0o777, 0o600);
    const expiresAt = Date.parse(first.expiresAt);
    assert.isAtLeast(expiresAt, before + 30 * 24 * 60 * 60 * 1000 - 1000);
    assert.isAtMost(
      expiresAt,
      DateTime.toEpochMillis(DateTime.nowUnsafe()) + 30 * 24 * 60 * 60 * 1000,
    );

    // Expiry or corruption of the old credential never prevents renewal.
    writeFileSync(sessionPath, encodeSession({ ...first, expiresAt: "2000-01-01T00:00:00Z" }));
    provisionDesktopSession(serverEntry, baseDir);
    const second = decodeSession(readFileSync(sessionPath, "utf8"));
    assert.notEqual(second.sessionId, first.sessionId);
    assert.notEqual(second.token, first.token);
    const sessions = decodeSessions(
      execFileSync(
        process.execPath,
        [serverEntry, "auth", "session", "list", "--base-dir", baseDir, "--json"],
        { encoding: "utf8" },
      ),
    );
    assert.deepEqual(sessions, [{ sessionId: second.sessionId, subject: "desktop-local" }]);

    assert.throws(
      () => provisionDesktopSession(join(baseDir, "missing.mjs"), baseDir),
      /command failed/,
    );
    assert.deepEqual(decodeSession(readFileSync(sessionPath, "utf8")), second);
  }).pipe(Effect.scoped),
);
