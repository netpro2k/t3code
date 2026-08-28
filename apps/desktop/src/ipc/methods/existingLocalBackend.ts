import {
  DesktopExistingLocalBackendStateSchema,
  type DesktopExistingLocalBackendState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopBackendConfiguration from "../../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const readExistingLocalBackendState: Effect.Effect<
  DesktopExistingLocalBackendState,
  never,
  DesktopBackendConfiguration.DesktopBackendConfiguration | DesktopBackendPool.DesktopBackendPool
> = Effect.gen(function* () {
  const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const existing = yield* configuration.resolveExistingLocalBackend;
  const primary = yield* pool.primary;
  const startConfig = Option.getOrUndefined(yield* primary.currentConfig);
  const attached = startConfig?.attachedPid !== undefined;
  return {
    attached,
    origin: attached
      ? startConfig.httpBaseUrl.href
      : Option.match(existing, {
          onNone: () => null,
          onSome: (backend) => backend.origin,
        }),
  };
});

export const getExistingLocalBackendState = makeIpcMethod({
  channel: IpcChannels.GET_EXISTING_LOCAL_BACKEND_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopExistingLocalBackendStateSchema,
  handler: Effect.fn("desktop.ipc.existingLocalBackend.getState")(function* () {
    return yield* readExistingLocalBackendState;
  }),
});
