import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  CornerUpRightIcon,
  GripVerticalIcon,
  ListOrderedIcon,
  PaperclipIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  desktopMessageQueueKey,
  EMPTY_DESKTOP_MESSAGE_QUEUE,
  type DesktopQueuedMessage,
  useDesktopMessageQueueStore,
} from "../../desktopMessageQueue";
import { releasePersistedAttachmentUpload } from "../../lib/attachmentUploadQueue";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { SessionPhase } from "../../types";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function SortableQueuedMessageRow(props: {
  readonly message: DesktopQueuedMessage;
  readonly index: number;
  readonly dragDisabled: boolean;
  readonly isBusy: boolean;
  readonly isFailed: boolean;
  readonly canRetry: boolean;
  readonly canSteer: boolean;
  readonly onRetry: () => void;
  readonly onSteer: () => void;
  readonly onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.message.messageId, disabled: props.dragDisabled });
  const label =
    (props.message.displayText || props.message.text).replace(/\s+/g, " ").trim() || "Attachment";

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex min-w-0 items-center gap-1 border-border/45 border-b px-2 py-1.5 last:border-b-0",
        isDragging && "relative z-10 rounded-lg border border-border/70 bg-popover shadow-lg",
      )}
      data-queued-message-dragging={isDragging ? "true" : "false"}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={setActivatorNodeRef}
              type="button"
              className="flex size-7 shrink-0 touch-none items-center justify-center rounded-md text-muted-foreground/55 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-35 enabled:cursor-grab enabled:active:cursor-grabbing"
              disabled={props.dragDisabled}
              aria-label={`Drag queued message ${props.index + 1} to reorder`}
              {...attributes}
              {...listeners}
            />
          }
        >
          <GripVerticalIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          Drag to reorder. Keyboard: press Space, use the arrow keys, then press Space again.
        </TooltipPopup>
      </Tooltip>
      {props.message.attachments.length > 0 ? (
        <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 flex-1 truncate px-1 text-sm text-foreground" />}
        >
          {label}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-lg whitespace-normal break-words">
          {label}
        </TooltipPopup>
      </Tooltip>
      {props.isFailed && props.canRetry ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs"
          disabled={props.isBusy}
          onClick={props.onRetry}
        >
          <RotateCcwIcon className="size-3" />
          Retry
        </Button>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              disabled={!props.canSteer || props.isBusy}
              onClick={props.onSteer}
            />
          }
        >
          <CornerUpRightIcon className="size-3.5" />
          {props.isBusy ? "Sending" : "Steer"}
        </TooltipTrigger>
        <TooltipPopup side="top">
          {props.canSteer
            ? "Send this message into the active turn"
            : "Steer is available while a turn is running"}
        </TooltipPopup>
      </Tooltip>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Delete queued message"
        disabled={props.isBusy}
        onClick={props.onRemove}
      >
        <Trash2Icon className="size-3.5" />
      </Button>
    </li>
  );
}

export function DesktopQueuedMessages(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
}) {
  const queue = useDesktopMessageQueueStore(
    (state) =>
      state.queuesByThreadKey[desktopMessageQueueKey(props.environmentId, props.threadId)] ??
      EMPTY_DESKTOP_MESSAGE_QUEUE,
  );
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const remove = useDesktopMessageQueueStore((state) => state.remove);
  const reorder = useDesktopMessageQueueStore((state) => state.reorder);
  const [busyMessageId, setBusyMessageId] = useState<MessageId | null>(null);
  const [startingMessageId, setStartingMessageId] = useState<MessageId | null>(null);
  const [failedMessageId, setFailedMessageId] = useState<MessageId | null>(null);
  const waitingForRunCycleRef = useRef(false);
  const sawRunningRef = useRef(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const sortableMessageIds = useMemo(() => queue.map((message) => message.messageId), [queue]);

  const dispatchMessage = useCallback(
    async (
      message: DesktopQueuedMessage,
      options?: { readonly keepUntilRunning?: boolean },
    ): Promise<boolean> => {
      setBusyMessageId(message.messageId);
      const result = await startThreadTurn({
        environmentId: message.environmentId,
        input: {
          commandId: message.commandId,
          threadId: message.threadId,
          message: {
            messageId: message.messageId,
            role: "user",
            text: message.text,
            attachments: message.attachments,
          },
          modelSelection: message.modelSelection,
          titleSeed: message.titleSeed,
          runtimeMode: message.runtimeMode,
          interactionMode: message.interactionMode,
          createdAt: message.createdAt,
        },
      });
      setBusyMessageId(null);

      if (result._tag === "Failure") {
        setFailedMessageId(message.messageId);
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Queued message was not sent",
              description:
                error instanceof Error ? error.message : "The message remains in the queue.",
            }),
          );
        }
        return false;
      }

      if (options?.keepUntilRunning) {
        setStartingMessageId(message.messageId);
      } else {
        remove(message.environmentId, message.threadId, message.messageId);
      }
      setFailedMessageId((current) => (current === message.messageId ? null : current));
      return true;
    },
    [remove, startThreadTurn],
  );

  useEffect(() => {
    if (!waitingForRunCycleRef.current) return;
    if (props.phase === "running") {
      sawRunningRef.current = true;
      if (startingMessageId !== null) {
        remove(props.environmentId, props.threadId, startingMessageId);
        setStartingMessageId(null);
      }
      return;
    }
    if (props.phase === "ready" && sawRunningRef.current) {
      waitingForRunCycleRef.current = false;
      sawRunningRef.current = false;
    }
  }, [props.environmentId, props.phase, props.threadId, remove, startingMessageId]);

  useEffect(() => {
    const nextMessage = queue[0];
    if (
      !nextMessage ||
      props.phase !== "ready" ||
      props.isSendBusy ||
      busyMessageId !== null ||
      startingMessageId !== null ||
      waitingForRunCycleRef.current ||
      failedMessageId === nextMessage.messageId
    ) {
      return;
    }

    waitingForRunCycleRef.current = true;
    sawRunningRef.current = false;
    void dispatchMessage(nextMessage, { keepUntilRunning: true }).then((sent) => {
      if (!sent) {
        waitingForRunCycleRef.current = false;
      }
    });
  }, [
    busyMessageId,
    dispatchMessage,
    failedMessageId,
    props.isSendBusy,
    props.phase,
    queue,
    startingMessageId,
  ]);

  useEffect(() => {
    if (failedMessageId && !queue.some((message) => message.messageId === failedMessageId)) {
      setFailedMessageId(null);
    }
  }, [failedMessageId, queue]);

  const retryHead = useCallback(() => {
    const nextMessage = queue[0];
    if (!nextMessage || busyMessageId !== null || startingMessageId !== null) return;
    setFailedMessageId(null);
    waitingForRunCycleRef.current = true;
    sawRunningRef.current = false;
    void dispatchMessage(nextMessage, { keepUntilRunning: true }).then((sent) => {
      if (!sent) waitingForRunCycleRef.current = false;
    });
  }, [busyMessageId, dispatchMessage, queue, startingMessageId]);

  const discardMessage = useCallback(
    (message: DesktopQueuedMessage) => {
      for (const attachment of message.attachments) {
        if (!("id" in attachment)) continue;
        releasePersistedAttachmentUpload({
          id: attachment.id,
          environmentId: message.environmentId,
          attachmentId: attachment.id,
        });
      }
      remove(message.environmentId, message.threadId, message.messageId);
    },
    [remove],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (
        event.over === null ||
        event.active.id === event.over.id ||
        busyMessageId !== null ||
        startingMessageId !== null
      ) {
        return;
      }
      reorder(
        props.environmentId,
        props.threadId,
        event.active.id as MessageId,
        event.over.id as MessageId,
      );
    },
    [busyMessageId, props.environmentId, props.threadId, reorder, startingMessageId],
  );

  if (queue.length === 0) return null;

  const interactionBusy = busyMessageId !== null || startingMessageId !== null;

  return (
    <section
      aria-label={`${queue.length} queued message${queue.length === 1 ? "" : "s"}`}
      aria-live="polite"
      className="mx-auto mb-2 w-full max-w-3xl overflow-hidden rounded-2xl border border-border/70 bg-background/90 shadow-lg backdrop-blur-xl"
    >
      <header className="flex h-9 items-center gap-2 border-border/55 border-b px-3 text-xs text-secondary-label">
        <ListOrderedIcon className="size-3.5" />
        <span className="font-medium text-foreground">Queued</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
          {queue.length}
        </span>
        <span className="ml-auto">
          {startingMessageId !== null
            ? "Starting next message"
            : props.phase === "running"
              ? "Runs after the current turn"
              : "Sending in order"}
        </span>
      </header>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={sortableMessageIds} strategy={verticalListSortingStrategy}>
          <ol className="max-h-64 overflow-y-auto">
            {queue.map((message, index) => {
              const isBusy =
                busyMessageId === message.messageId || startingMessageId === message.messageId;
              const isFailed = failedMessageId === message.messageId;
              return (
                <SortableQueuedMessageRow
                  key={message.messageId}
                  message={message}
                  index={index}
                  dragDisabled={interactionBusy}
                  isBusy={isBusy}
                  isFailed={isFailed}
                  canRetry={isFailed && index === 0 && props.phase === "ready"}
                  canSteer={props.phase === "running" && !interactionBusy}
                  onRetry={retryHead}
                  onSteer={() => void dispatchMessage(message)}
                  onRemove={() => discardMessage(message)}
                />
              );
            })}
          </ol>
        </SortableContext>
      </DndContext>
    </section>
  );
}
