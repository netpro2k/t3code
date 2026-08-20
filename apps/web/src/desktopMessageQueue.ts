import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  ChatAttachment,
  CommandId,
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { create } from "zustand";

export const DESKTOP_MESSAGE_QUEUE_STORAGE_KEY = "t3code:desktop-message-queue:v1";
const STORAGE_VERSION = 1;

export interface DesktopQueuedMessage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly displayText: string;
  readonly attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly titleSeed: string;
  readonly createdAt: string;
}

interface PersistedDesktopMessageQueue {
  readonly version: number;
  readonly queuesByThreadKey: Record<string, ReadonlyArray<DesktopQueuedMessage>>;
}

function readPersistedQueues(): Record<string, ReadonlyArray<DesktopQueuedMessage>> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(DESKTOP_MESSAGE_QUEUE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedDesktopMessageQueue>;
    if (
      parsed.version !== STORAGE_VERSION ||
      parsed.queuesByThreadKey === null ||
      typeof parsed.queuesByThreadKey !== "object"
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed.queuesByThreadKey).filter((entry) => Array.isArray(entry[1])),
    );
  } catch {
    return {};
  }
}

function persistQueues(
  queuesByThreadKey: Record<string, ReadonlyArray<DesktopQueuedMessage>>,
): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(
      DESKTOP_MESSAGE_QUEUE_STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, queuesByThreadKey }),
    );
    return true;
  } catch {
    return false;
  }
}

export function desktopMessageQueueKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

interface DesktopMessageQueueState {
  readonly queuesByThreadKey: Record<string, ReadonlyArray<DesktopQueuedMessage>>;
  readonly enqueue: (message: DesktopQueuedMessage) => { durable: boolean };
  readonly remove: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    messageId: MessageId,
  ) => { durable: boolean };
  readonly reorder: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    activeMessageId: MessageId,
    overMessageId: MessageId,
  ) => { durable: boolean };
}

export const useDesktopMessageQueueStore = create<DesktopMessageQueueState>()((set, get) => ({
  queuesByThreadKey: readPersistedQueues(),
  enqueue: (message) => {
    const key = desktopMessageQueueKey(message.environmentId, message.threadId);
    const current = get().queuesByThreadKey[key] ?? [];
    const queuesByThreadKey = {
      ...get().queuesByThreadKey,
      [key]: [...current.filter((item) => item.messageId !== message.messageId), message],
    };
    const durable = persistQueues(queuesByThreadKey);
    set({ queuesByThreadKey });
    return { durable };
  },
  remove: (environmentId, threadId, messageId) => {
    const key = desktopMessageQueueKey(environmentId, threadId);
    const nextQueue = (get().queuesByThreadKey[key] ?? []).filter(
      (message) => message.messageId !== messageId,
    );
    const queuesByThreadKey = { ...get().queuesByThreadKey };
    if (nextQueue.length > 0) {
      queuesByThreadKey[key] = nextQueue;
    } else {
      delete queuesByThreadKey[key];
    }
    const durable = persistQueues(queuesByThreadKey);
    set({ queuesByThreadKey });
    return { durable };
  },
  reorder: (environmentId, threadId, activeMessageId, overMessageId) => {
    const key = desktopMessageQueueKey(environmentId, threadId);
    const nextQueue = [...(get().queuesByThreadKey[key] ?? [])];
    const activeIndex = nextQueue.findIndex((message) => message.messageId === activeMessageId);
    const overIndex = nextQueue.findIndex((message) => message.messageId === overMessageId);
    if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
      return { durable: true };
    }
    const [message] = nextQueue.splice(activeIndex, 1);
    nextQueue.splice(overIndex, 0, message!);
    const queuesByThreadKey = { ...get().queuesByThreadKey, [key]: nextQueue };
    const durable = persistQueues(queuesByThreadKey);
    set({ queuesByThreadKey });
    return { durable };
  },
}));

export const EMPTY_DESKTOP_MESSAGE_QUEUE: ReadonlyArray<DesktopQueuedMessage> = [];

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== DESKTOP_MESSAGE_QUEUE_STORAGE_KEY) return;
    useDesktopMessageQueueStore.setState({ queuesByThreadKey: readPersistedQueues() });
  });
}
