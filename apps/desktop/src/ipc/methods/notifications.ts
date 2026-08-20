import {
  DesktopNotificationShowInputSchema,
  DesktopNotificationShowResultSchema,
  DesktopNotificationTargetSchema,
  type DesktopNotificationEvent,
  type DesktopNotificationShowInput,
  type DesktopNotificationTarget,
} from "@t3tools/contracts";
import { headlineForPhase, type AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const MACOS_NOTIFICATION_SOUND_NAME = "t3-notification";
export const MACOS_NOTIFICATION_SOUND_FILE = `${MACOS_NOTIFICATION_SOUND_NAME}.wav`;

const notifications = new Map<string, Electron.Notification>();

function notificationTargetKey(target: DesktopNotificationTarget): string {
  return JSON.stringify([target.environmentId, target.threadId]);
}

function closeNotification(key: string): void {
  const existing = notifications.get(key);
  notifications.delete(key);
  existing?.close();
}

function closeAllNotifications(): void {
  for (const notification of notifications.values()) {
    notification.close();
  }
  notifications.clear();
}

/**
 * Native notification copy tracks the phrasing the iOS awareness push already
 * uses, so the same thread state reads identically on both surfaces. "plan" has
 * no awareness phase of its own — awareness collapses it into the thread simply
 * waiting on the user — so it carries the only desktop-local string here.
 */
function notificationBody(event: DesktopNotificationEvent): string {
  if (event === "plan") {
    return "Plan ready for review";
  }
  return headlineForPhase(awarenessPhaseForEvent(event));
}

function awarenessPhaseForEvent(
  event: Exclude<DesktopNotificationEvent, "plan">,
): AgentAwarenessPhase {
  switch (event) {
    case "approval":
      return "waiting_for_approval";
    case "input":
      return "waiting_for_input";
    case "completion":
      return "completed";
    case "failure":
      return "failed";
  }
}

function revealNotificationTarget(
  desktopWindow: DesktopWindow.DesktopWindow["Service"],
  target: DesktopNotificationTarget,
): Effect.Effect<void> {
  return desktopWindow.revealOrCreateMain.pipe(
    Effect.tap((window) =>
      Effect.sync(() => {
        const send = () => {
          if (!window.isDestroyed()) {
            window.webContents.send(IpcChannels.DESKTOP_NOTIFICATION_ACTIVATED_CHANNEL, target);
          }
        };

        if (window.webContents.isLoadingMainFrame()) {
          window.webContents.once("did-finish-load", send);
        } else {
          send();
        }
      }),
    ),
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not reveal a native macOS notification target.", { cause }),
    ),
  );
}

/**
 * UNNotificationSound looks up a name (no extension) in the app bundle and in
 * ~/Library/Sounds. Packaged builds ship the wav via extraResources; unpackaged
 * Electron's bundle is Electron.app, so we install the same file by name.
 */
export const resolveMacOSNotificationSoundName = Effect.fn(
  "desktop.ipc.notifications.resolveSound",
)(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform !== "darwin") {
    return undefined;
  }

  const assets = yield* DesktopAssets.DesktopAssets;
  const sourcePath = yield* assets
    .resolveResourcePath(MACOS_NOTIFICATION_SOUND_FILE)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not probe the macOS notification sound.", { cause }).pipe(
          Effect.as(Option.none<string>()),
        ),
      ),
    );
  if (Option.isNone(sourcePath)) {
    return undefined;
  }
  if (environment.isPackaged) {
    return MACOS_NOTIFICATION_SOUND_NAME;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const destinationDir = environment.path.join(environment.homeDirectory, "Library", "Sounds");
  const destinationPath = environment.path.join(destinationDir, MACOS_NOTIFICATION_SOUND_FILE);
  const alreadyInstalled = yield* fileSystem
    .exists(destinationPath)
    .pipe(Effect.orElseSucceed(() => false));
  if (alreadyInstalled) {
    return MACOS_NOTIFICATION_SOUND_NAME;
  }

  const installed = yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(destinationDir, { recursive: true });
    yield* fileSystem.copyFile(sourcePath.value, destinationPath);
    return true;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not install the unpackaged macOS notification sound.", {
        cause,
      }).pipe(Effect.as(false)),
    ),
  );
  return installed ? MACOS_NOTIFICATION_SOUND_NAME : undefined;
});

function showNotification(
  input: DesktopNotificationShowInput,
  desktopWindow: DesktopWindow.DesktopWindow["Service"],
  sound: string | undefined,
): "shown" | "failed" {
  const key = notificationTargetKey(input);

  try {
    closeNotification(key);
    const notification = new Electron.Notification({
      title: input.threadTitle,
      subtitle: input.projectTitle,
      body: notificationBody(input.event),
      silent: false,
      ...(sound === undefined ? {} : { sound }),
    });
    notifications.set(key, notification);

    const clearIfCurrent = () => {
      if (notifications.get(key) === notification) {
        notifications.delete(key);
      }
    };

    notification.once("close", clearIfCurrent);
    notification.once("click", () => {
      clearIfCurrent();
      notification.close();
      Effect.runFork(
        revealNotificationTarget(desktopWindow, {
          environmentId: input.environmentId,
          threadId: input.threadId,
        }),
      );
    });
    notification.on("failed", (_event, error) => {
      clearIfCurrent();
      Effect.runFork(
        Effect.logWarning("Native macOS notification delivery failed.", {
          error,
          notificationKey: key,
        }),
      );
    });
    notification.show();
    return "shown";
  } catch (cause) {
    Effect.runFork(
      Effect.logWarning("Could not show a native macOS notification.", {
        cause,
        notificationKey: key,
      }),
    );
    return "failed";
  }
}

export const showDesktopNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_NOTIFICATION_SHOW_CHANNEL,
  payload: DesktopNotificationShowInputSchema,
  result: DesktopNotificationShowResultSchema,
  handler: Effect.fn("desktop.ipc.notifications.show")(function* (input) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin" || !Electron.Notification.isSupported()) {
      return "unsupported" as const;
    }
    const allowWhileFocused = input.event === "completion" && input.allowWhileFocused;
    if (!allowWhileFocused && Electron.BrowserWindow.getFocusedWindow() !== null) {
      return "suppressed" as const;
    }

    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const sound = yield* resolveMacOSNotificationSoundName();
    return yield* Effect.sync(() => showNotification(input, desktopWindow, sound));
  }),
});

export const dismissDesktopNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_NOTIFICATION_DISMISS_CHANNEL,
  payload: DesktopNotificationTargetSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.notifications.dismiss")(function* (target) {
    yield* Effect.sync(() => closeNotification(notificationTargetKey(target)));
  }),
});

export const dismissAllDesktopNotifications = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_NOTIFICATION_DISMISS_ALL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.notifications.dismissAll")(function* () {
    yield* Effect.sync(closeAllNotifications);
  }),
});
