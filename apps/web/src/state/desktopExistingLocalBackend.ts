import type { DesktopBridge, DesktopExistingLocalBackendState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

const DESKTOP_EXISTING_LOCAL_BACKEND_STALE_TIME_MS = 30_000;

type DesktopExistingLocalBackendBridge = Pick<DesktopBridge, "getExistingLocalBackendState">;

class DesktopExistingLocalBackendUnavailableError extends Schema.TaggedErrorClass<DesktopExistingLocalBackendUnavailableError>()(
  "DesktopExistingLocalBackendUnavailableError",
  {},
) {
  override get message(): string {
    return "Desktop existing-local-backend state is unavailable.";
  }
}

class DesktopExistingLocalBackendLoadError extends Schema.TaggedErrorClass<DesktopExistingLocalBackendLoadError>()(
  "DesktopExistingLocalBackendLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load existing local backend state.";
  }
}

function getDesktopExistingLocalBackendBridge(): DesktopExistingLocalBackendBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createDesktopExistingLocalBackendStateAtom(
  getBridge: () => DesktopExistingLocalBackendBridge | undefined,
) {
  const loadState = Effect.fn("loadDesktopExistingLocalBackendState")(function* () {
    const bridge = getBridge();
    if (!bridge?.getExistingLocalBackendState) {
      return yield* new DesktopExistingLocalBackendUnavailableError();
    }
    return yield* Effect.tryPromise({
      try: (): Promise<DesktopExistingLocalBackendState> => bridge.getExistingLocalBackendState!(),
      catch: (cause) => new DesktopExistingLocalBackendLoadError({ cause }),
    });
  });

  return Atom.make(loadState()).pipe(
    Atom.swr({
      staleTime: DESKTOP_EXISTING_LOCAL_BACKEND_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.keepAlive,
    Atom.withLabel("desktop:existing-local-backend:load"),
  );
}

export const desktopExistingLocalBackendStateAtom = createDesktopExistingLocalBackendStateAtom(
  getDesktopExistingLocalBackendBridge,
);
