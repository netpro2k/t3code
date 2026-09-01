import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type DispatchResult,
  EnvironmentHttpApi,
  type ClientOrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  RuntimeMode,
  ThreadId,
  MessageId,
} from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

type ThreadDispatchCommand = Extract<
  ClientOrchestrationCommand,
  {
    type:
      | "thread.create"
      | "thread.turn.start"
      | "thread.settle"
      | "thread.unsettle"
      | "thread.session.stop";
  }
>;

export type ThreadCliState =
  | "queued"
  | "starting"
  | "working"
  | "blocked"
  | "background"
  | "failed"
  | "completed"
  | "idle"
  | "settled";

// Keep this bound aligned with the queued-turn guards in the decider and
// client-runtime. A user message newer than any adopted turn is pending work,
// but an old unadopted message is a failed/stale start rather than a queue.
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

const hasQueuedTurnStart = (thread: OrchestrationThreadShell, now: string) => {
  if (thread.latestUserMessageAt === null || thread.session?.status === "error") return false;
  const messageAt = Date.parse(thread.latestUserMessageAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(messageAt) || Number.isNaN(nowMs)) return false;
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestTurn === null) return true;
  return [
    thread.latestTurn.requestedAt,
    thread.latestTurn.startedAt,
    thread.latestTurn.completedAt,
  ].every((candidate) => candidate === null || Date.parse(candidate) < messageAt);
};

export class ThreadCliError extends Schema.TaggedErrorClass<ThreadCliError>()("ThreadCliError", {
  operation: Schema.String,
  detail: Schema.String,
  threadId: Schema.optional(ThreadId),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.threadId === undefined
      ? this.detail
      : `${this.detail} Thread ID: ${this.threadId}.`;
  }
}

export const deriveThreadCliState = (
  thread: OrchestrationThreadShell,
  now: string,
): ThreadCliState => {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "blocked";
  if (thread.session?.status === "running") return "working";
  if (thread.session?.status === "starting") return "starting";
  if (hasQueuedTurnStart(thread, now)) return "queued";
  if (thread.latestTurn?.state === "running")
    return thread.latestTurn.startedAt === null ? "queued" : "working";
  if (thread.hasActionableProposedPlan) return "blocked";
  if (thread.backgroundLiveness != null) return "background";
  if (thread.settledOverride === "settled") return "settled";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "failed";
  if (thread.latestTurn?.state === "completed") return "completed";
  return "idle";
};

export const filterThreadShells = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
  state: "active" | "settled" | "all",
  projectId?: string,
) =>
  threads
    .filter((thread) => projectId === undefined || thread.projectId === projectId)
    .filter((thread) =>
      state === "all"
        ? true
        : state === "settled"
          ? thread.settledOverride === "settled"
          : thread.settledOverride !== "settled",
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

export const resolveThreadProject = Effect.fn("resolveThreadProject")(function* (
  snapshot: OrchestrationShellSnapshot,
  selector: string,
) {
  const value = selector.trim();
  if (value.length === 0) {
    return yield* new ThreadCliError({
      operation: "resolveProject",
      detail: "Project cannot be empty.",
    });
  }
  const byId = snapshot.projects.find((project) => project.id === value);
  if (byId) return byId;
  const paths = yield* WorkspacePaths.WorkspacePaths;
  const normalized = yield* Effect.result(paths.normalizeWorkspaceRoot(value));
  const byPath =
    normalized._tag === "Success"
      ? snapshot.projects.find((project) => project.workspaceRoot === normalized.success)
      : undefined;
  if (byPath) return byPath;
  return yield* new ThreadCliError({
    operation: "resolveProject",
    detail: `No project matches '${value}'.`,
    ...(normalized._tag === "Failure" ? { cause: normalized.failure } : {}),
  });
});

export const makeThreadRunCommands = (input: {
  project: OrchestrationProjectShell;
  prompt: string;
  title?: string;
  runtimeMode: RuntimeMode;
  threadId: ThreadId;
  createCommandId: CommandId;
  startCommandId: CommandId;
  messageId: MessageId;
  createdAt: string;
}): readonly [
  Extract<ThreadDispatchCommand, { type: "thread.create" }>,
  Extract<ThreadDispatchCommand, { type: "thread.turn.start" }>,
] => {
  const seededTitle = truncate(input.prompt);
  const explicitTitle = input.title?.trim();
  const title = explicitTitle === undefined ? seededTitle : explicitTitle;
  return [
    {
      type: "thread.create",
      commandId: input.createCommandId,
      threadId: input.threadId,
      projectId: input.project.id,
      title,
      modelSelection:
        input.project.defaultModelSelection ??
        ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
      runtimeMode: input.runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: input.createdAt,
    },
    {
      type: "thread.turn.start",
      commandId: input.startCommandId,
      threadId: input.threadId,
      message: { messageId: input.messageId, role: "user", text: input.prompt, attachments: [] },
      modelSelection:
        input.project.defaultModelSelection ??
        ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
      ...(explicitTitle === undefined ? { titleSeed: seededTitle } : {}),
      runtimeMode: input.runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: input.createdAt,
    },
  ];
};

const uuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(
    (cause) =>
      new ThreadCliError({
        operation: "generateId",
        detail: "Could not generate an identifier.",
        cause,
      }),
  ),
);

const makeClient = (origin: string) => HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
const timeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(Duration.seconds(3)));

const runLive = Effect.fn("runThreadCliLive")(function* <A>(
  flags: { readonly baseDir: Option.Option<string> },
  access: "read" | "operate",
  use: (input: {
    snapshot: OrchestrationShellSnapshot;
    dispatch: (
      command: ThreadDispatchCommand,
    ) => Effect.Effect<DispatchResult, ThreadCliError, HttpClient.HttpClient>;
  }) => Effect.Effect<
    A,
    ThreadCliError,
    | Crypto.Crypto
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Path.Path
    | WorkspacePaths.WorkspacePaths
  >,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtime)) {
      return yield* new ThreadCliError({
        operation: "connect",
        detail: "No running local T3 server was found.",
      });
    }
    return yield* Effect.acquireUseRelease(
      auth.issueSession({
        scopes:
          access === "operate"
            ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
            : [AuthOrchestrationReadScope],
        label: "t3 thread cli",
      }),
      (session) =>
        Effect.gen(function* () {
          const client = yield* makeClient(runtime.value.origin);
          const headers = { authorization: `Bearer ${session.token}` };
          const snapshot = yield* timeout(client.orchestration.shellSnapshot({ headers })).pipe(
            Effect.mapError(
              (cause) =>
                new ThreadCliError({
                  operation: "readShell",
                  detail: "Could not read the running server.",
                  cause,
                }),
            ),
          );
          return yield* use({
            snapshot,
            dispatch: (command) =>
              timeout(
                client.orchestration.dispatch({ headers, payload: command } as Parameters<
                  typeof client.orchestration.dispatch
                >[0]),
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new ThreadCliError({
                      operation: "dispatch",
                      detail: "The running server did not accept or confirm the command.",
                      cause,
                    }),
                ),
              ),
          });
        }),
      (session) => auth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.runtimeLayer, WorkspacePaths.layer).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );
});

const print = (json: boolean, value: unknown, human: string) =>
  Console.log(json ? JSON.stringify(value) : human);

const runProject = Flag.string("project").pipe(
  Flag.withDescription("Project id or exact workspace path. Defaults to the current directory."),
  Flag.optional,
);
const listProject = Flag.string("project").pipe(
  Flag.withDescription("Restrict results to a project id or exact workspace path."),
  Flag.optional,
);
const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit machine-readable JSON."),
  Flag.withDefault(false),
);

const readRunPrompt = Effect.fn("readThreadRunPrompt")(function* (
  prompt: Option.Option<string>,
  promptFile: Option.Option<string>,
) {
  const promptArgument = Option.getOrUndefined(prompt);
  const promptFilePath = Option.getOrUndefined(promptFile);
  if ((promptArgument === undefined) === (promptFilePath === undefined)) {
    return yield* new ThreadCliError({
      operation: "readPrompt",
      detail: "Provide exactly one of a prompt argument or --prompt-file.",
    });
  }
  const rawPrompt =
    promptArgument ??
    (yield* FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.readFileString(promptFilePath!)),
      Effect.mapError(
        (cause) =>
          new ThreadCliError({
            operation: "readPrompt",
            detail: `Could not read '${promptFilePath}'.`,
            cause,
          }),
      ),
    ));
  const normalized = rawPrompt.trim();
  if (normalized.length === 0) {
    return yield* new ThreadCliError({
      operation: "readPrompt",
      detail: "Prompt cannot be empty.",
    });
  }
  return normalized;
});

const runCommand = Command.make("run", {
  ...projectLocationFlags,
  prompt: Argument.string("prompt").pipe(
    Argument.withDescription("Prompt for the first turn."),
    Argument.optional,
  ),
  promptFile: Flag.string("prompt-file").pipe(
    Flag.withDescription("Read the first-turn prompt from a file."),
    Flag.optional,
  ),
  project: runProject,
  title: Flag.string("title").pipe(
    Flag.withDescription("Keep this title instead of generating one from the prompt."),
    Flag.optional,
  ),
  runtimeMode: Flag.choice("runtime-mode", RuntimeMode.literals).pipe(
    Flag.withDescription("Permission mode for the new thread."),
    Flag.withDefault(DEFAULT_RUNTIME_MODE),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a thread and start its first turn on a running T3 server."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const prompt = yield* readRunPrompt(flags.prompt, flags.promptFile);
      const explicitTitle = Option.getOrUndefined(flags.title);
      if (explicitTitle !== undefined && explicitTitle.trim().length === 0) {
        return yield* new ThreadCliError({
          operation: "validateTitle",
          detail: "Title cannot be empty.",
        });
      }
      return yield* runLive(
        flags,
        "operate",
        Effect.fn("threadRun")(function* ({ snapshot, dispatch }) {
          const selector = Option.getOrUndefined(flags.project) ?? process.cwd();
          const project = yield* resolveThreadProject(snapshot, selector);
          const threadId = ThreadId.make(yield* uuid);
          const commands = makeThreadRunCommands({
            project,
            prompt,
            ...(explicitTitle === undefined ? {} : { title: explicitTitle }),
            runtimeMode: flags.runtimeMode,
            threadId,
            createCommandId: CommandId.make(yield* uuid),
            startCommandId: CommandId.make(yield* uuid),
            messageId: MessageId.make(yield* uuid),
            createdAt: DateTime.formatIso(yield* DateTime.now),
          });
          yield* dispatch(commands[0]).pipe(
            Effect.mapError(
              (cause) =>
                new ThreadCliError({
                  operation: "createThread",
                  detail: "Thread creation could not be confirmed; check before retrying.",
                  threadId,
                  cause,
                }),
            ),
          );
          const result = yield* dispatch(commands[1]).pipe(
            Effect.mapError(
              (cause) =>
                new ThreadCliError({
                  operation: "startTurn",
                  detail: "The thread was preserved, but its first turn could not be started.",
                  threadId,
                  cause,
                }),
            ),
          );
          yield* print(
            flags.json,
            {
              threadId,
              projectId: project.id,
              title: commands[0].title,
              state: "queued",
              sequence: result.sequence,
            },
            `Started thread ${threadId}.`,
          );
        }),
      );
    }),
  ),
);

const listCommand = Command.make("list", {
  ...projectLocationFlags,
  project: listProject,
  state: Flag.choice("state", ["active", "settled", "all"] as const).pipe(
    Flag.withDescription("Thread lifecycle filter."),
    Flag.withDefault("active" as const),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active, settled, or all threads."),
  Command.withHandler((flags) =>
    runLive(
      flags,
      "read",
      Effect.fn("threadList")(function* ({ snapshot }) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const project = Option.isSome(flags.project)
          ? yield* resolveThreadProject(snapshot, flags.project.value)
          : undefined;
        const threads = filterThreadShells(snapshot.threads, flags.state, project?.id).map(
          (thread) => ({
            id: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            state: deriveThreadCliState(thread, now),
            updatedAt: thread.updatedAt,
          }),
        );
        yield* print(
          flags.json,
          threads,
          threads.length === 0
            ? "No matching threads."
            : threads.map((thread) => `${thread.id}\t${thread.state}\t${thread.title}`).join("\n"),
        );
      }),
    ),
  ),
);

const findThread = (snapshot: OrchestrationShellSnapshot, id: string) => {
  const thread = snapshot.threads.find((candidate) => candidate.id === id);
  return thread === undefined
    ? Effect.fail(
        new ThreadCliError({ operation: "resolveThread", detail: `No thread matches '${id}'.` }),
      )
    : Effect.succeed(thread);
};

const statusCommand = Command.make("status", {
  ...projectLocationFlags,
  thread: Argument.string("thread").pipe(
    Argument.withDescription("Durable thread id returned by run or list."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show the current state of one thread."),
  Command.withHandler((flags) =>
    runLive(
      flags,
      "read",
      Effect.fn("threadStatus")(function* ({ snapshot }) {
        const thread = yield* findThread(snapshot, flags.thread);
        const now = DateTime.formatIso(yield* DateTime.now);
        const value = {
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          state: deriveThreadCliState(thread, now),
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          linkedPullRequest: thread.linkedPullRequest ?? null,
          session: thread.session,
          latestTurn: thread.latestTurn,
          pending: {
            approval: thread.hasPendingApprovals,
            userInput: thread.hasPendingUserInput,
            proposedPlan: thread.hasActionableProposedPlan,
          },
          backgroundLiveness: thread.backgroundLiveness ?? null,
          planProgress: thread.planProgress ?? null,
          settledOverride: thread.settledOverride,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          settledAt: thread.settledAt,
        };
        const provider = `${thread.modelSelection.instanceId}/${thread.modelSelection.model}`;
        const waitingOn = [
          ...(thread.hasPendingApprovals ? ["approval"] : []),
          ...(thread.hasPendingUserInput ? ["user input"] : []),
          ...(thread.hasActionableProposedPlan ? ["plan decision"] : []),
        ];
        const human = [
          `Thread ${value.id}`,
          `  Title: ${value.title}`,
          `  Project: ${value.projectId}`,
          `  State: ${value.state}`,
          `  Lifecycle: ${value.settledOverride ?? "automatic"}`,
          `  Provider: ${provider}`,
          `  Session: ${value.session?.status ?? "none"}`,
          `  Latest turn: ${value.latestTurn?.state ?? "none"}`,
          `  Runtime mode: ${value.runtimeMode}`,
          `  Workspace: ${value.worktreePath ?? "shared checkout"}`,
          ...(value.branch === null ? [] : [`  Branch: ${value.branch}`]),
          ...(waitingOn.length === 0 ? [] : [`  Waiting on: ${waitingOn.join(", ")}`]),
          ...(value.backgroundLiveness === null
            ? []
            : [`  Background work: ${value.backgroundLiveness}`]),
          ...(value.planProgress === null
            ? []
            : [
                `  Plan: ${value.planProgress.completedSteps}/${value.planProgress.totalSteps} ${value.planProgress.step}`,
              ]),
          ...(value.session?.lastError === null || value.session?.lastError === undefined
            ? []
            : [`  Last error: ${value.session.lastError}`]),
          `  Updated: ${value.updatedAt}`,
        ].join("\n");
        yield* print(flags.json, value, human);
      }),
    ),
  ),
);

const parkingCommand = (kind: "settle" | "unsettle") =>
  Command.make(kind, {
    ...projectLocationFlags,
    thread: Argument.string("thread").pipe(
      Argument.withDescription("Durable thread id returned by run or list."),
    ),
    json: jsonFlag,
  }).pipe(
    Command.withDescription(
      kind === "settle" ? "Mark an inactive thread as settled." : "Reopen a settled thread.",
    ),
    Command.withHandler((flags) =>
      runLive(
        flags,
        "operate",
        Effect.fn(`thread${kind}`)(function* ({ snapshot, dispatch }) {
          const thread = yield* findThread(snapshot, flags.thread);
          const commandId = CommandId.make(yield* uuid);
          if (kind === "unsettle") {
            yield* dispatch({
              type: "thread.unsettle",
              commandId,
              threadId: thread.id,
              reason: "user",
            });
          } else {
            const shouldStop = thread.session !== null && thread.session.status !== "stopped";
            yield* dispatch({ type: "thread.settle", commandId, threadId: thread.id });
            if (shouldStop) {
              yield* dispatch({
                type: "thread.session.stop",
                commandId: CommandId.make(`session-stop-for-settle:${commandId}`),
                threadId: thread.id,
                createdAt: DateTime.formatIso(yield* DateTime.now),
                onlyIfSettled: true,
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Failed to stop settled thread session.", {
                    threadId: thread.id,
                    cause,
                  }),
                ),
              );
            }
          }
          yield* print(
            flags.json,
            { threadId: thread.id, state: kind === "settle" ? "settled" : "active" },
            `${kind === "settle" ? "Settled" : "Unsettled"} thread ${thread.id}.`,
          );
        }),
      ),
    ),
  );

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Create and manage threads on a running T3 server."),
  Command.withSubcommands([
    runCommand,
    listCommand,
    statusCommand,
    parkingCommand("settle"),
    parkingCommand("unsettle"),
  ]),
);
