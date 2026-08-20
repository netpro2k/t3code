import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DESKTOP_MESSAGE_QUEUE_STORAGE_KEY,
  desktopMessageQueueKey,
  type DesktopQueuedMessage,
  useDesktopMessageQueueStore,
} from "./desktopMessageQueue";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "./types";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

function createLocalStorageStub(options?: { throwOnSet?: boolean }): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => {
      store.clear();
    },
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      if (options?.throwOnSet) {
        throw new Error("quota exceeded");
      }
      store.set(key, value);
    },
  };
}

function makeQueuedMessage(
  overrides: Partial<DesktopQueuedMessage> &
    Pick<DesktopQueuedMessage, "environmentId" | "threadId" | "messageId">,
): DesktopQueuedMessage {
  return {
    commandId: CommandId.make(`command-${overrides.messageId}`),
    text: `send ${overrides.messageId}`,
    displayText: `display ${overrides.messageId}`,
    attachments: [],
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    titleSeed: "Queued message",
    createdAt: "2026-08-20T12:00:00.000Z",
    ...overrides,
  };
}

function queueFor(environmentId: EnvironmentId, threadId: ThreadId) {
  return (
    useDesktopMessageQueueStore.getState().queuesByThreadKey[
      desktopMessageQueueKey(environmentId, threadId)
    ] ?? []
  );
}

function resetQueueStore() {
  useDesktopMessageQueueStore.setState({ queuesByThreadKey: {} });
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(DESKTOP_MESSAGE_QUEUE_STORAGE_KEY);
  }
}

describe("desktopMessageQueueStore", () => {
  let localStorageStub: Storage;

  beforeEach(() => {
    localStorageStub = createLocalStorageStub();
    vi.stubGlobal("localStorage", localStorageStub);
    resetQueueStore();
  });

  afterEach(() => {
    resetQueueStore();
    vi.unstubAllGlobals();
  });

  it("appends messages per thread and isolates queues across threads", () => {
    const store = useDesktopMessageQueueStore.getState();
    const first = makeQueuedMessage({
      environmentId: environmentA,
      threadId: threadA,
      messageId: MessageId.make("msg-1"),
    });
    const second = makeQueuedMessage({
      environmentId: environmentA,
      threadId: threadA,
      messageId: MessageId.make("msg-2"),
    });
    const otherThread = makeQueuedMessage({
      environmentId: environmentA,
      threadId: threadB,
      messageId: MessageId.make("msg-other"),
    });

    expect(store.enqueue(first).durable).toBe(true);
    expect(store.enqueue(second).durable).toBe(true);
    expect(store.enqueue(otherThread).durable).toBe(true);

    expect(queueFor(environmentA, threadA).map((message) => message.messageId)).toEqual([
      "msg-1",
      "msg-2",
    ]);
    expect(queueFor(environmentA, threadB).map((message) => message.messageId)).toEqual([
      "msg-other",
    ]);
    expect(queueFor(environmentB, threadA)).toEqual([]);
  });

  it("replaces a message with the same id by moving it to the end", () => {
    const store = useDesktopMessageQueueStore.getState();
    store.enqueue(
      makeQueuedMessage({
        environmentId: environmentA,
        threadId: threadA,
        messageId: MessageId.make("msg-1"),
        text: "first",
      }),
    );
    store.enqueue(
      makeQueuedMessage({
        environmentId: environmentA,
        threadId: threadA,
        messageId: MessageId.make("msg-2"),
      }),
    );
    store.enqueue(
      makeQueuedMessage({
        environmentId: environmentA,
        threadId: threadA,
        messageId: MessageId.make("msg-1"),
        text: "updated",
      }),
    );

    const queue = queueFor(environmentA, threadA);
    expect(queue.map((message) => message.messageId)).toEqual(["msg-2", "msg-1"]);
    expect(queue[1]?.text).toBe("updated");
  });

  it("preserves file attachments when persisting a queued message", () => {
    const store = useDesktopMessageQueueStore.getState();
    const fileAttachment = {
      type: "file" as const,
      id: "pending-notes-txt",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    };

    store.enqueue(
      makeQueuedMessage({
        environmentId: environmentA,
        threadId: threadA,
        messageId: MessageId.make("msg-file"),
        attachments: [fileAttachment],
      }),
    );

    expect(queueFor(environmentA, threadA)[0]?.attachments).toEqual([fileAttachment]);
    const persisted = JSON.parse(
      localStorageStub.getItem(DESKTOP_MESSAGE_QUEUE_STORAGE_KEY) ?? "{}",
    );
    expect(
      persisted.queuesByThreadKey[desktopMessageQueueKey(environmentA, threadA)][0].attachments,
    ).toEqual([fileAttachment]);
  });

  it("removes a message and drops empty thread queues", () => {
    const store = useDesktopMessageQueueStore.getState();
    store.enqueue(
      makeQueuedMessage({
        environmentId: environmentA,
        threadId: threadA,
        messageId: MessageId.make("msg-1"),
      }),
    );
    store.enqueue(
      makeQueuedMessage({
        environmentId: environmentA,
        threadId: threadA,
        messageId: MessageId.make("msg-2"),
      }),
    );

    store.remove(environmentA, threadA, MessageId.make("msg-1"));
    expect(queueFor(environmentA, threadA).map((message) => message.messageId)).toEqual(["msg-2"]);

    store.remove(environmentA, threadA, MessageId.make("msg-2"));
    expect(
      desktopMessageQueueKey(environmentA, threadA) in
        useDesktopMessageQueueStore.getState().queuesByThreadKey,
    ).toBe(false);
  });

  it("reorders messages and no-ops when either id is missing", () => {
    const store = useDesktopMessageQueueStore.getState();
    store.enqueue(
      makeQueuedMessage({
        environmentId: environmentA,
        threadId: threadA,
        messageId: MessageId.make("msg-1"),
      }),
    );
    store.enqueue(
      makeQueuedMessage({
        environmentId: environmentA,
        threadId: threadA,
        messageId: MessageId.make("msg-2"),
      }),
    );
    store.enqueue(
      makeQueuedMessage({
        environmentId: environmentA,
        threadId: threadA,
        messageId: MessageId.make("msg-3"),
      }),
    );

    store.reorder(environmentA, threadA, MessageId.make("msg-3"), MessageId.make("msg-1"));
    expect(queueFor(environmentA, threadA).map((message) => message.messageId)).toEqual([
      "msg-3",
      "msg-1",
      "msg-2",
    ]);

    store.reorder(environmentA, threadA, MessageId.make("msg-3"), MessageId.make("missing"));
    expect(queueFor(environmentA, threadA).map((message) => message.messageId)).toEqual([
      "msg-3",
      "msg-1",
      "msg-2",
    ]);
  });

  it("keeps the in-memory queue when storage writes fail", () => {
    vi.unstubAllGlobals();
    const failingStorage = createLocalStorageStub({ throwOnSet: true });
    vi.stubGlobal("localStorage", failingStorage);
    resetQueueStore();

    const result = useDesktopMessageQueueStore.getState().enqueue(
      makeQueuedMessage({
        environmentId: environmentA,
        threadId: threadA,
        messageId: MessageId.make("msg-1"),
      }),
    );

    expect(result.durable).toBe(false);
    expect(queueFor(environmentA, threadA).map((message) => message.messageId)).toEqual(["msg-1"]);
    expect(failingStorage.getItem(DESKTOP_MESSAGE_QUEUE_STORAGE_KEY)).toBeNull();
  });
});
