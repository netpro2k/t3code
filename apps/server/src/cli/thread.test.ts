import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationProjectShell,
  type OrchestrationSession,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import {
  ThreadCliError,
  deriveThreadCliState,
  filterThreadShells,
  makeThreadRunCommands,
} from "./thread.ts";

const project = {
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as OrchestrationProjectShell;

const NOW = "2026-01-01T00:00:01.000Z";

const makeSession = (status: OrchestrationSession["status"]): OrchestrationSession => ({
  threadId: ThreadId.make("thread-1"),
  status,
  providerName: "Codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: status === "error" ? "Provider failed" : null,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeThread = (overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell =>
  ({
    id: ThreadId.make("thread-1"),
    projectId: project.id,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  }) as OrchestrationThreadShell;

describe("makeThreadRunCommands", () => {
  const base = {
    project,
    prompt:
      "Investigate the flaky integration test and fix its root cause without masking failures",
    runtimeMode: "full-access" as const,
    threadId: ThreadId.make("thread-1"),
    createCommandId: CommandId.make("create-1"),
    startCommandId: CommandId.make("start-1"),
    messageId: MessageId.make("message-1"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("uses the shared prompt truncation for the default title and title seed", () => {
    const [create, start] = makeThreadRunCommands(base);

    assert.equal(create.title, "Investigate the flaky integration test and fix its...");
    assert.equal(start.titleSeed, create.title);
    assert.equal(create.modelSelection.instanceId, "codex");
    assert.equal(create.modelSelection.model, "gpt-5.6-sol");
    assert.deepEqual(start.modelSelection, create.modelSelection);
  });

  it("preserves an explicit title and omits titleSeed", () => {
    const [create, start] = makeThreadRunCommands({ ...base, title: "Nightly test audit" });

    assert.equal(create.title, "Nightly test audit");
    assert.equal("titleSeed" in start, false);
  });
});

describe("thread CLI state", () => {
  it("keeps actionable work visible even if a stale shell is marked settled", () => {
    assert.equal(
      deriveThreadCliState(
        makeThread({ settledOverride: "settled", hasPendingApprovals: true }),
        NOW,
      ),
      "blocked",
    );
    assert.equal(deriveThreadCliState(makeThread({ hasPendingUserInput: true }), NOW), "blocked");
    assert.equal(
      deriveThreadCliState(makeThread({ latestUserMessageAt: "2026-01-01T00:00:00.000Z" }), NOW),
      "queued",
    );
    assert.equal(
      deriveThreadCliState(
        makeThread({ latestUserMessageAt: "2026-01-01T00:00:00.000Z" }),
        "2026-01-01T00:03:00.000Z",
      ),
      "idle",
    );
    assert.equal(
      deriveThreadCliState(makeThread({ latestUserMessageAt: "not-a-date" }), NOW),
      "idle",
    );
    assert.equal(
      deriveThreadCliState(makeThread({ latestUserMessageAt: "2026-01-01T00:03:00.000Z" }), NOW),
      "idle",
    );
    assert.equal(
      deriveThreadCliState(
        makeThread({
          latestUserMessageAt: "2026-01-01T00:00:00.000Z",
          latestTurn: {
            turnId: TurnId.make("turn-adopted"),
            state: "completed",
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
            assistantMessageId: null,
          },
        }),
        NOW,
      ),
      "completed",
    );
    assert.equal(
      deriveThreadCliState(
        makeThread({
          latestUserMessageAt: "2026-01-01T00:00:00.000Z",
          session: makeSession("error"),
        }),
        NOW,
      ),
      "failed",
    );
    assert.equal(
      deriveThreadCliState(
        makeThread({
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "running",
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
        }),
        NOW,
      ),
      "queued",
    );
    assert.equal(
      deriveThreadCliState(
        makeThread({
          session: makeSession("starting"),
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "running",
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
        }),
        NOW,
      ),
      "starting",
    );
    assert.equal(
      deriveThreadCliState(
        makeThread({ session: makeSession("running"), hasActionableProposedPlan: true }),
        NOW,
      ),
      "working",
    );
    assert.equal(
      deriveThreadCliState(makeThread({ backgroundLiveness: "monitoring" }), NOW),
      "background",
    );
    assert.equal(deriveThreadCliState(makeThread({ settledOverride: "settled" }), NOW), "settled");
    assert.equal(deriveThreadCliState(makeThread(), NOW), "idle");
  });

  it("treats active as not explicitly settled", () => {
    const implicit = makeThread({ id: ThreadId.make("implicit"), settledOverride: null });
    const active = makeThread({ id: ThreadId.make("active"), settledOverride: "active" });
    const settled = makeThread({ id: ThreadId.make("settled"), settledOverride: "settled" });

    assert.deepEqual(
      filterThreadShells([implicit, active, settled], "active").map((thread) => thread.id),
      [implicit.id, active.id],
    );
    assert.deepEqual(
      filterThreadShells([implicit, active, settled], "settled").map((thread) => thread.id),
      [settled.id],
    );
  });
});

it("reports the preserved thread id after an ambiguous start failure", () => {
  const error = new ThreadCliError({
    operation: "startTurn",
    detail: "The thread was preserved, but its first turn could not be started.",
    threadId: ThreadId.make("thread-preserved"),
  });

  assert.equal(
    error.message,
    "The thread was preserved, but its first turn could not be started. Thread ID: thread-preserved.",
  );
});
