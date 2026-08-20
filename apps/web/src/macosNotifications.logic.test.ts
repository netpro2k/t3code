import type {
  EnvironmentId,
  OrchestrationLatestTurn,
  OrchestrationSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { MacOSNotificationSettings } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  macOSCompletionProven,
  macOSNotificationAllowsFocusedDelivery,
  macOSNotificationEventEnabled,
  macOSNotificationVersion,
  reconcileMacOSNotificationStates,
  resolveMacOSNotificationPhase,
  shouldDeliverMacOSNotification,
  type MacOSNotificationPhase,
  type MacOSNotificationThreadState,
  type ObservedMacOSNotificationState,
  type RememberedMacOSNotificationState,
} from "./macosNotifications.logic";

const NOW = "2026-08-19T20:00:00.000Z";
const LATER = "2026-08-19T20:05:00.000Z";
const target = {
  environmentId: "environment-local" as EnvironmentId,
  threadId: "thread-1" as ThreadId,
};

function notificationSettings(
  overrides: Partial<MacOSNotificationSettings> = {},
): MacOSNotificationSettings {
  return {
    turnCompletion: "unfocused",
    permissionNotifications: true,
    questionNotifications: true,
    ...overrides,
  };
}

function thread(
  overrides: Partial<MacOSNotificationThreadState> = {},
): MacOSNotificationThreadState {
  return {
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
    latestUserMessageAt: NOW,
    session: {
      status: "running",
      activeTurnId: "turn-1" as TurnId,
    } as Pick<OrchestrationSession, "status" | "activeTurnId">,
    latestTurn: {
      turnId: "turn-1" as TurnId,
      state: "running",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
    } as Pick<
      OrchestrationLatestTurn,
      "turnId" | "state" | "requestedAt" | "startedAt" | "completedAt"
    >,
    ...overrides,
  };
}

function observed(
  phase: MacOSNotificationPhase,
  version = "prompt:2026-08-19T20:00:00.000Z",
  completionProven = phase === "completion",
): ObservedMacOSNotificationState {
  return {
    key: "environment-local:thread-1",
    target,
    projectTitle: "T3 Code",
    threadTitle: "Implement notifications",
    phase,
    version,
    completionProven,
  };
}

function remembered(
  phase: MacOSNotificationPhase,
  version = "prompt:2026-08-19T20:00:00.000Z",
  completionNotifiedVersion = phase === "completion" ? version : null,
  completionProven = phase === "completion",
): RememberedMacOSNotificationState {
  return {
    ...observed(phase, version, completionProven),
    completionNotifiedVersion,
  };
}

describe("resolveMacOSNotificationPhase", () => {
  it("prioritizes approvals over ordinary running state", () => {
    expect(
      resolveMacOSNotificationPhase(
        thread({
          hasPendingApprovals: true,
        }),
      ),
    ).toBe("approval");
  });

  it("prioritizes terminal failure over stale running state", () => {
    expect(
      resolveMacOSNotificationPhase(
        thread({
          session: { status: "error", activeTurnId: null },
        }),
      ),
    ).toBe("failure");
  });

  it("keeps a completed turn active while delegated work is alive", () => {
    expect(
      resolveMacOSNotificationPhase(
        thread({
          backgroundLiveness: "working",
          session: { status: "ready", activeTurnId: null },
          latestTurn: {
            turnId: "turn-1" as TurnId,
            state: "completed",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
          },
        }),
      ),
    ).toBe("active");
  });

  it("allows completion while only a long-lived monitor remains", () => {
    expect(
      resolveMacOSNotificationPhase(
        thread({
          backgroundLiveness: "monitoring",
          session: { status: "ready", activeTurnId: null },
          latestTurn: {
            turnId: "turn-1" as TurnId,
            state: "completed",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
          },
        }),
      ),
    ).toBe("completion");
  });

  it("treats an actionable plan as attention only after work settles", () => {
    expect(
      resolveMacOSNotificationPhase(
        thread({
          hasActionableProposedPlan: true,
          session: { status: "ready", activeTurnId: null },
          latestTurn: {
            turnId: "turn-1" as TurnId,
            state: "completed",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
          },
        }),
      ),
    ).toBe("plan");
  });

  it("treats teardown-interrupted turns with a completion timestamp as completed", () => {
    expect(
      resolveMacOSNotificationPhase(
        thread({
          session: { status: "ready", activeTurnId: null },
          latestTurn: {
            turnId: "turn-1" as TurnId,
            state: "interrupted",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
          },
        }),
      ),
    ).toBe("completion");
  });

  it("does not call a genuinely interrupted turn completed", () => {
    expect(
      resolveMacOSNotificationPhase(
        thread({
          session: { status: "ready", activeTurnId: null },
          latestTurn: {
            turnId: "turn-1" as TurnId,
            state: "interrupted",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: null,
          },
        }),
      ),
    ).toBe("idle");
  });

  it("uses a ready session as fallback for no-checkpoint turns", () => {
    expect(
      resolveMacOSNotificationPhase(
        thread({
          session: { status: "ready", activeTurnId: null },
          latestTurn: null,
        }),
      ),
    ).toBe("completion");
  });

  it("suppresses archived threads", () => {
    expect(resolveMacOSNotificationPhase(thread({ archivedAt: NOW }))).toBe("idle");
  });
});

describe("reconcileMacOSNotificationStates", () => {
  it("uses the first shell snapshot as a baseline", () => {
    expect(reconcileMacOSNotificationStates(null, [observed("completion")]).transitions).toEqual(
      [],
    );
  });

  it("treats a newly discovered thread as a baseline", () => {
    expect(
      reconcileMacOSNotificationStates(new Map(), [observed("completion")]).transitions,
    ).toEqual([]);
  });

  it("does not mistake a newly queued prompt for a completion", () => {
    expect(
      reconcileMacOSNotificationStates(
        new Map([[remembered("completion").key, remembered("completion")]]),
        [observed("completion", `prompt:${LATER}`, false)],
      ).transitions,
    ).toEqual([{ type: "dismiss", target }]);
  });

  it("notifies once when active work completes", () => {
    expect(
      reconcileMacOSNotificationStates(
        new Map([[remembered("active").key, remembered("active")]]),
        [observed("completion")],
      ).transitions,
    ).toEqual([{ type: "show", event: "completion", state: observed("completion") }]);
  });

  it("notifies for a no-checkpoint completion after observing active work", () => {
    const active = observed("active");
    const completion = observed("completion", active.version, false);
    const prior = remembered("active");
    expect(
      reconcileMacOSNotificationStates(new Map([[prior.key, prior]]), [completion]).transitions,
    ).toEqual([{ type: "show", event: "completion", state: completion }]);
  });

  it("notifies when a thread needs approval, input, plan review, or failure attention", () => {
    for (const phase of ["approval", "input", "plan", "failure"] as const) {
      expect(
        reconcileMacOSNotificationStates(
          new Map([[remembered("active").key, remembered("active")]]),
          [observed(phase)],
        ).transitions,
      ).toEqual([{ type: "show", event: phase, state: observed(phase) }]);
    }
  });

  it("dismisses an attention notification when the agent resumes", () => {
    expect(
      reconcileMacOSNotificationStates(new Map([[remembered("input").key, remembered("input")]]), [
        observed("active"),
      ]).transitions,
    ).toEqual([{ type: "dismiss", target }]);
  });

  it("does not replay completion on metadata-only updates", () => {
    expect(
      reconcileMacOSNotificationStates(
        new Map([[remembered("completion").key, remembered("completion")]]),
        [observed("completion")],
      ).transitions,
    ).toEqual([]);
  });

  it("does not notify twice when background continuation reopens the same prompt cycle", () => {
    const reopened = reconcileMacOSNotificationStates(
      new Map([[remembered("completion").key, remembered("completion")]]),
      [observed("active")],
    );
    expect(reopened.transitions).toEqual([{ type: "dismiss", target }]);
    expect(
      reconcileMacOSNotificationStates(reopened.next, [observed("completion")]).transitions,
    ).toEqual([]);
  });

  it("notifies when an atomically completed prompt becomes proven", () => {
    const version = `prompt:${LATER}`;
    const prior = remembered("completion", version, null, false);
    const current = observed("completion", version, true);
    expect(
      reconcileMacOSNotificationStates(new Map([[prior.key, prior]]), [current]).transitions,
    ).toEqual([{ type: "show", event: "completion", state: current }]);
  });

  it("allows a proven later turn to notify even if both snapshots are completed", () => {
    const prior = remembered("completion");
    const current = observed("completion", `prompt:${LATER}`);
    expect(
      reconcileMacOSNotificationStates(new Map([[prior.key, prior]]), [current]).transitions,
    ).toEqual([
      { type: "dismiss", target },
      {
        type: "show",
        event: "completion",
        state: current,
      },
    ]);
  });
});

describe("notification preferences", () => {
  it("supports never, unfocused, and always completion modes", () => {
    expect(
      shouldDeliverMacOSNotification({
        settings: notificationSettings({ turnCompletion: "never" }),
        event: "completion",
        windowFocused: false,
      }),
    ).toBe(false);
    expect(
      shouldDeliverMacOSNotification({
        settings: notificationSettings({ turnCompletion: "unfocused" }),
        event: "completion",
        windowFocused: false,
      }),
    ).toBe(true);
    expect(
      shouldDeliverMacOSNotification({
        settings: notificationSettings({ turnCompletion: "unfocused" }),
        event: "completion",
        windowFocused: true,
      }),
    ).toBe(false);
    expect(
      shouldDeliverMacOSNotification({
        settings: notificationSettings({ turnCompletion: "always" }),
        event: "completion",
        windowFocused: true,
      }),
    ).toBe(true);
  });

  it("only allows focused native delivery for completion in always mode", () => {
    const settings = notificationSettings({ turnCompletion: "always" });
    expect(macOSNotificationAllowsFocusedDelivery(settings, "completion")).toBe(true);
    expect(macOSNotificationAllowsFocusedDelivery(settings, "approval")).toBe(false);
    expect(macOSNotificationAllowsFocusedDelivery(settings, "input")).toBe(false);
  });

  it("lets permission and question toggles suppress their event families", () => {
    const disabled = notificationSettings({
      permissionNotifications: false,
      questionNotifications: false,
    });
    expect(macOSNotificationEventEnabled(disabled, "approval")).toBe(false);
    expect(macOSNotificationEventEnabled(disabled, "input")).toBe(false);
    expect(macOSNotificationEventEnabled(disabled, "plan")).toBe(false);
    expect(macOSNotificationEventEnabled(disabled, "failure")).toBe(true);
  });

  it("keeps attention and failure notifications quiet while the app is focused", () => {
    const settings = notificationSettings();
    for (const event of ["approval", "input", "plan", "failure"] as const) {
      expect(shouldDeliverMacOSNotification({ settings, event, windowFocused: true })).toBe(false);
      expect(shouldDeliverMacOSNotification({ settings, event, windowFocused: false })).toBe(true);
    }
  });
});

it("uses the user prompt as the stable notification cycle identity", () => {
  expect(macOSNotificationVersion(thread())).toBe(`prompt:${NOW}`);
  expect(macOSNotificationVersion(thread({ latestUserMessageAt: null }))).toBe("turn:turn-1");
});

it("only proves a direct completion when the completed turn matches the prompt", () => {
  const completedTurn = {
    turnId: "turn-1" as TurnId,
    state: "completed" as const,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
  };
  expect(
    macOSCompletionProven(
      thread({
        session: { status: "ready", activeTurnId: null },
        latestTurn: completedTurn,
      }),
    ),
  ).toBe(true);
  expect(
    macOSCompletionProven(
      thread({
        latestUserMessageAt: LATER,
        session: { status: "ready", activeTurnId: null },
        latestTurn: completedTurn,
      }),
    ),
  ).toBe(false);
});
