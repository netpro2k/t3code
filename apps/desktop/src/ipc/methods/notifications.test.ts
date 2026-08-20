import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import {
  MACOS_NOTIFICATION_SOUND_FILE,
  MACOS_NOTIFICATION_SOUND_NAME,
  resolveMacOSNotificationSoundName,
} from "./notifications.ts";

const defaultEnvironmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin" as const,
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const sourceSoundPath = `/repo/apps/desktop/resources/${MACOS_NOTIFICATION_SOUND_FILE}`;
const librarySoundPath = `/Users/alice/Library/Sounds/${MACOS_NOTIFICATION_SOUND_FILE}`;

function makeEnvironmentLayer(
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
) {
  return DesktopEnvironment.layer({
    ...defaultEnvironmentInput,
    ...overrides,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));
}

function makeSoundLayer(input: {
  readonly environment?: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput>;
  readonly exists?: (path: string) => boolean;
  readonly copyFile?: (
    from: string,
    to: string,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
}) {
  const environmentLayer = makeEnvironmentLayer(input.environment);
  const fileSystemLayer = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(input.exists?.(String(path)) ?? false),
    makeDirectory: () => Effect.void,
    copyFile: input.copyFile ?? (() => Effect.void),
  });
  return Layer.mergeAll(
    fileSystemLayer,
    environmentLayer,
    DesktopAssets.layer.pipe(Layer.provide(Layer.merge(fileSystemLayer, environmentLayer))),
  );
}

describe("resolveMacOSNotificationSoundName", () => {
  it.effect("vendors the notification chime next to other desktop resources", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const resourcePath = yield* path.fromFileUrl(
        new URL(`../../../resources/${MACOS_NOTIFICATION_SOUND_FILE}`, import.meta.url),
      );
      assert.isTrue(yield* fileSystem.exists(resourcePath));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the bundled sound name for packaged macOS builds", () => {
    const copied: Array<readonly [string, string]> = [];
    return Effect.gen(function* () {
      const sound = yield* resolveMacOSNotificationSoundName();

      assert.equal(sound, MACOS_NOTIFICATION_SOUND_NAME);
      assert.deepEqual(copied, []);
    }).pipe(
      Effect.provide(
        makeSoundLayer({
          exists: (path) => path.endsWith(MACOS_NOTIFICATION_SOUND_FILE),
          copyFile: (from, to) =>
            Effect.sync(() => {
              copied.push([from, to]);
            }),
        }),
      ),
    );
  });

  it.effect("installs the unpackaged sound into the user Library Sounds folder", () => {
    const copied: Array<readonly [string, string]> = [];
    return Effect.gen(function* () {
      const sound = yield* resolveMacOSNotificationSoundName();

      assert.equal(sound, MACOS_NOTIFICATION_SOUND_NAME);
      assert.deepEqual(copied, [[sourceSoundPath, librarySoundPath]]);
    }).pipe(
      Effect.provide(
        makeSoundLayer({
          environment: { isPackaged: false },
          exists: (path) => path === sourceSoundPath,
          copyFile: (from, to) =>
            Effect.sync(() => {
              copied.push([from, to]);
            }),
        }),
      ),
    );
  });

  it.effect("reuses an already installed unpackaged sound without copying again", () => {
    const copied: Array<readonly [string, string]> = [];
    return Effect.gen(function* () {
      const sound = yield* resolveMacOSNotificationSoundName();

      assert.equal(sound, MACOS_NOTIFICATION_SOUND_NAME);
      assert.deepEqual(copied, []);
    }).pipe(
      Effect.provide(
        makeSoundLayer({
          environment: { isPackaged: false },
          exists: (path) => path === sourceSoundPath || path === librarySoundPath,
          copyFile: (from, to) =>
            Effect.sync(() => {
              copied.push([from, to]);
            }),
        }),
      ),
    );
  });

  it.effect("omits a custom sound when the wav is missing", () =>
    Effect.gen(function* () {
      const sound = yield* resolveMacOSNotificationSoundName();
      assert.equal(sound, undefined);
    }).pipe(Effect.provide(makeSoundLayer({ environment: { isPackaged: false } }))),
  );

  it.effect("omits a custom sound on non-macOS platforms", () => {
    const copied: Array<readonly [string, string]> = [];
    return Effect.gen(function* () {
      const sound = yield* resolveMacOSNotificationSoundName();

      assert.equal(sound, undefined);
      assert.deepEqual(copied, []);
    }).pipe(
      Effect.provide(
        makeSoundLayer({
          environment: { platform: "linux", isPackaged: false },
          exists: (path) => path.endsWith(MACOS_NOTIFICATION_SOUND_FILE),
          copyFile: (from, to) =>
            Effect.sync(() => {
              copied.push([from, to]);
            }),
        }),
      ),
    );
  });

  it.effect("omits a custom sound when unpackaged install fails", () =>
    Effect.gen(function* () {
      const sound = yield* resolveMacOSNotificationSoundName();
      assert.equal(sound, undefined);
    }).pipe(
      Effect.provide(
        makeSoundLayer({
          environment: { isPackaged: false },
          exists: (path) => path === sourceSoundPath,
          copyFile: (from) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "copyFile",
                pathOrDescriptor: from,
                description: "private filesystem diagnostic",
              }),
            ),
        }),
      ),
    ),
  );
});
