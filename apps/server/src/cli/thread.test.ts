import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  CommandId,
  DEFAULT_MODEL,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationProjectShell,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  ThreadCliError,
  deriveThreadCliState,
  filterThreadShells,
  makeThreadRunCommands,
  resolveThreadRunModelSelection,
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

const codexProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    },
    {
      slug: "gpt-6-astra",
      name: "GPT-6-Astra",
      aliases: ["astra"],
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
              { id: "ultra", label: "Ultra", isDefault: true },
            ],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

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
    assert.equal(create.modelSelection.model, DEFAULT_MODEL);
    assert.deepEqual(start.modelSelection, create.modelSelection);
  });

  it("preserves an explicit title and omits titleSeed", () => {
    const [create, start] = makeThreadRunCommands({ ...base, title: "Nightly test audit" });

    assert.equal(create.title, "Nightly test audit");
    assert.equal("titleSeed" in start, false);
  });

  it("uses the same explicit selection for creation and the first turn", () => {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "ultra" }],
    } as const;
    const [create, start] = makeThreadRunCommands({ ...base, modelSelection });

    assert.deepEqual(create.modelSelection, modelSelection);
    assert.deepEqual(start.modelSelection, modelSelection);
  });
});

describe("resolveThreadRunModelSelection", () => {
  const projectWithDefault = {
    ...project,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "medium" }],
    },
  } satisfies OrchestrationProjectShell;

  it.effect("inherits the project default when no overrides are supplied", () =>
    Effect.gen(function* () {
      const selection = yield* resolveThreadRunModelSelection({
        project: projectWithDefault,
        providers: [],
      });
      assert.deepEqual(selection, projectWithDefault.defaultModelSelection);
    }),
  );

  it.effect("applies explicit model and effort overrides", () =>
    Effect.gen(function* () {
      const selection = yield* resolveThreadRunModelSelection({
        project: projectWithDefault,
        providers: [codexProvider],
        model: "gpt-6-astra",
        effort: "ultra",
      });
      assert.deepEqual(selection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "ultra" }],
      });
    }),
  );

  it.effect("overrides only the model while retaining compatible project options", () =>
    Effect.gen(function* () {
      const selection = yield* resolveThreadRunModelSelection({
        project: projectWithDefault,
        providers: [codexProvider],
        model: "gpt-6-astra",
      });
      assert.deepEqual(selection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "medium" }],
      });
    }),
  );

  it.effect("overrides only the effort on the inherited model", () =>
    Effect.gen(function* () {
      const selection = yield* resolveThreadRunModelSelection({
        project: projectWithDefault,
        providers: [codexProvider],
        effort: "high",
      });
      assert.deepEqual(selection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
    }),
  );

  it.effect("rejects unsupported models and efforts before command creation", () =>
    Effect.gen(function* () {
      const modelError = yield* resolveThreadRunModelSelection({
        project: projectWithDefault,
        providers: [codexProvider],
        model: "gpt-unknown",
      }).pipe(Effect.flip);
      assert.match(modelError.message, /Model 'gpt-unknown' is not supported/);

      const effortError = yield* resolveThreadRunModelSelection({
        project: projectWithDefault,
        providers: [codexProvider],
        model: "gpt-6-astra",
        effort: "impossible",
      }).pipe(Effect.flip);
      assert.match(effortError.message, /Available efforts: medium, high, ultra/);
    }),
  );
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
