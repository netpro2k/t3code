import type {
  DesktopNotificationEvent,
  DesktopNotificationTarget,
  OrchestrationLatestTurn,
  OrchestrationSession,
} from "@t3tools/contracts";
import type { MacOSNotificationSettings } from "@t3tools/contracts/settings";

import { isLatestTurnSettled } from "./session-logic";

export type MacOSNotificationPhase =
  | "idle"
  | "active"
  | "approval"
  | "input"
  | "plan"
  | "completion"
  | "failure";

export interface MacOSNotificationThreadState {
  readonly archivedAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
  readonly latestUserMessageAt: string | null;
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null;
  readonly latestTurn: Pick<
    OrchestrationLatestTurn,
    "turnId" | "state" | "requestedAt" | "startedAt" | "completedAt"
  > | null;
}

export interface ObservedMacOSNotificationState {
  readonly key: string;
  readonly target: DesktopNotificationTarget;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: MacOSNotificationPhase;
  readonly version: string;
  readonly completionProven: boolean;
}

export interface RememberedMacOSNotificationState extends ObservedMacOSNotificationState {
  readonly completionNotifiedVersion: string | null;
}

export type MacOSNotificationTransition =
  | {
      readonly type: "dismiss";
      readonly target: DesktopNotificationTarget;
    }
  | {
      readonly type: "show";
      readonly event: DesktopNotificationEvent;
      readonly state: ObservedMacOSNotificationState;
    };

export function resolveMacOSNotificationPhase(
  thread: MacOSNotificationThreadState,
): MacOSNotificationPhase {
  if (thread.archivedAt != null) {
    return "idle";
  }
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return "failure";
  }
  if (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running" ||
    thread.backgroundLiveness === "working"
  ) {
    return "active";
  }
  if (thread.hasActionableProposedPlan) {
    return "plan";
  }
  const latestTurnCompleted =
    thread.latestTurn?.state === "completed" ||
    (thread.latestTurn?.state === "interrupted" && thread.latestTurn.completedAt !== null);
  if (latestTurnCompleted && isLatestTurnSettled(thread.latestTurn, thread.session)) {
    return "completion";
  }
  // Shells can clear latestTurn for no-checkpoint turns. A ready/idle session
  // after a real user message is the remaining completion signal.
  if (
    thread.latestTurn == null &&
    thread.latestUserMessageAt != null &&
    (thread.session?.status === "ready" || thread.session?.status === "idle")
  ) {
    return "completion";
  }
  return "idle";
}

export function macOSCompletionProven(thread: MacOSNotificationThreadState): boolean {
  const latestTurnCompleted =
    thread.latestTurn?.state === "completed" ||
    (thread.latestTurn?.state === "interrupted" && thread.latestTurn.completedAt !== null);
  if (!latestTurnCompleted || !isLatestTurnSettled(thread.latestTurn, thread.session)) {
    return false;
  }
  return (
    thread.latestUserMessageAt == null ||
    thread.latestTurn.requestedAt >= thread.latestUserMessageAt
  );
}

export function macOSNotificationVersion(thread: MacOSNotificationThreadState): string {
  if (thread.latestUserMessageAt != null) {
    return `prompt:${thread.latestUserMessageAt}`;
  }
  const turnId = thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? null;
  return turnId === null ? "legacy" : `turn:${turnId}`;
}

export function notificationEventForPhase(
  phase: MacOSNotificationPhase,
): DesktopNotificationEvent | null {
  switch (phase) {
    case "approval":
    case "input":
    case "plan":
    case "completion":
    case "failure":
      return phase;
    case "active":
    case "idle":
      return null;
  }
}

export function macOSNotificationEventEnabled(
  settings: MacOSNotificationSettings,
  event: DesktopNotificationEvent,
): boolean {
  switch (event) {
    case "approval":
      return settings.permissionNotifications;
    case "input":
    case "plan":
      return settings.questionNotifications;
    case "completion":
      return settings.turnCompletion !== "never";
    case "failure":
      return true;
  }
}

export function macOSNotificationAllowsFocusedDelivery(
  settings: MacOSNotificationSettings,
  event: DesktopNotificationEvent,
): boolean {
  return event === "completion" && settings.turnCompletion === "always";
}

export function shouldDeliverMacOSNotification(input: {
  readonly settings: MacOSNotificationSettings;
  readonly event: DesktopNotificationEvent;
  readonly windowFocused: boolean;
}): boolean {
  return (
    macOSNotificationEventEnabled(input.settings, input.event) &&
    (!input.windowFocused || macOSNotificationAllowsFocusedDelivery(input.settings, input.event))
  );
}

export function reconcileMacOSNotificationStates(
  previous: ReadonlyMap<string, RememberedMacOSNotificationState> | null,
  observed: readonly ObservedMacOSNotificationState[],
): {
  readonly next: ReadonlyMap<string, RememberedMacOSNotificationState>;
  readonly transitions: readonly MacOSNotificationTransition[];
} {
  const next = new Map<string, RememberedMacOSNotificationState>();
  const transitions: MacOSNotificationTransition[] = [];

  for (const current of observed) {
    const prior = previous?.get(current.key);
    let completionNotifiedVersion = prior?.completionNotifiedVersion ?? null;

    if (prior === undefined) {
      // First sight of a proven completed thread is historical baseline, not news.
      if (current.phase === "completion" && current.completionProven) {
        completionNotifiedVersion = current.version;
      }
      next.set(current.key, { ...current, completionNotifiedVersion });
      continue;
    }

    const phaseChanged = prior.phase !== current.phase;
    const versionChanged = prior.version !== current.version;
    const completionBecameProven =
      current.phase === "completion" && !prior.completionProven && current.completionProven;
    if (phaseChanged || versionChanged || completionBecameProven) {
      if ((phaseChanged || versionChanged) && notificationEventForPhase(prior.phase) !== null) {
        transitions.push({ type: "dismiss", target: prior.target });
      }

      const event = notificationEventForPhase(current.phase);
      const transitionedFromLiveTurn =
        phaseChanged &&
        !versionChanged &&
        (prior.phase === "active" || prior.phase === "approval" || prior.phase === "input");
      const completionEligible = current.completionProven || transitionedFromLiveTurn;
      const completionAlreadyNotified = completionNotifiedVersion === current.version;
      const canShow =
        event !== null &&
        (event !== "completion" || (completionEligible && !completionAlreadyNotified));
      if (canShow) {
        transitions.push({ type: "show", event, state: current });
        if (event === "completion") {
          completionNotifiedVersion = current.version;
        }
      }
    }

    next.set(current.key, { ...current, completionNotifiedVersion });
  }

  if (previous !== null) {
    for (const [key, prior] of previous) {
      if (next.has(key)) {
        continue;
      }
      if (notificationEventForPhase(prior.phase) !== null) {
        transitions.push({ type: "dismiss", target: prior.target });
      }
    }
  }

  return { next, transitions };
}
