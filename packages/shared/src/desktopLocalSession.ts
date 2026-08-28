import * as Schema from "effect/Schema";

// Provisioned by the fork updater in the environment's userdata directory.
export const DESKTOP_LOCAL_SESSION_FILE = "desktop-session.json";
export const DesktopLocalSession = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  expiresAt: Schema.String,
});
export const DesktopLocalSessionJson = Schema.fromJsonString(DesktopLocalSession);
