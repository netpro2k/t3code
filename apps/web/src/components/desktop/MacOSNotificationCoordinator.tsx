import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { DesktopNotificationTarget } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  macOSCompletionProven,
  macOSNotificationAllowsFocusedDelivery,
  macOSNotificationVersion,
  reconcileMacOSNotificationStates,
  resolveMacOSNotificationPhase,
  shouldDeliverMacOSNotification,
  type ObservedMacOSNotificationState,
  type RememberedMacOSNotificationState,
} from "../../macosNotifications.logic";
import {
  getClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
} from "../../hooks/useSettings";
import {
  setActiveEnvironmentId,
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../../state/entities";

export function MacOSNotificationCoordinator() {
  const bridge = window.desktopBridge?.notifications;
  const notificationSettings = useClientSettings((settings) => settings.macOSNotifications);
  const settingsHydrated = useClientSettingsHydrated();
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const previousStatesRef = useRef<ReadonlyMap<string, RememberedMacOSNotificationState> | null>(
    null,
  );
  const notificationOperationsRef = useRef(Promise.resolve());

  const enqueueNotificationOperation = useCallback((operation: () => Promise<unknown>) => {
    notificationOperationsRef.current = notificationOperationsRef.current
      .then(operation)
      .then(() => undefined)
      .catch(() => undefined);
  }, []);

  const activateTarget = useCallback(
    (target: DesktopNotificationTarget) => {
      setActiveEnvironmentId(target.environmentId);
      void navigate({
        to: "/$environmentId/$threadId",
        params: target,
      });
    },
    [navigate],
  );

  const observed = useMemo(() => {
    const projectsByKey = new Map(
      projects.map((project) => [
        scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
        project,
      ]),
    );

    return threads.flatMap((thread): ObservedMacOSNotificationState[] => {
      const project = projectsByKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (!project) {
        return [];
      }
      const target = scopeThreadRef(thread.environmentId, thread.id);
      return [
        {
          key: scopedThreadKey(target),
          target,
          projectTitle: project.title,
          threadTitle: thread.title,
          phase: resolveMacOSNotificationPhase(thread),
          version: macOSNotificationVersion(thread),
          completionProven: macOSCompletionProven(thread),
        },
      ];
    });
  }, [projects, threads]);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    return bridge.onActivated(activateTarget);
  }, [activateTarget, bridge]);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    return () => {
      previousStatesRef.current = null;
      enqueueNotificationOperation(() => bridge.dismissAll());
    };
  }, [bridge, enqueueNotificationOperation]);

  useEffect(() => {
    if (!bridge || !settingsHydrated) {
      return;
    }
    enqueueNotificationOperation(() => bridge.dismissAll());
  }, [bridge, enqueueNotificationOperation, notificationSettings, settingsHydrated]);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    const dismissOnFocus = () => {
      enqueueNotificationOperation(() => bridge.dismissAll());
    };
    window.addEventListener("focus", dismissOnFocus);
    return () => {
      window.removeEventListener("focus", dismissOnFocus);
    };
  }, [bridge, enqueueNotificationOperation]);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    if (!settingsHydrated || !shellsBootstrapped) {
      if (previousStatesRef.current !== null) {
        previousStatesRef.current = null;
        enqueueNotificationOperation(() => bridge.dismissAll());
      }
      return;
    }

    const reconciliation = reconcileMacOSNotificationStates(previousStatesRef.current, observed);
    previousStatesRef.current = reconciliation.next;

    for (const transition of reconciliation.transitions) {
      enqueueNotificationOperation(async () => {
        if (transition.type === "dismiss") {
          await bridge.dismiss(transition.target);
          return;
        }

        const current = previousStatesRef.current?.get(transition.state.key);
        const deliverySettings = getClientSettings().macOSNotifications;
        const windowFocused = document.hasFocus();
        if (
          current === undefined ||
          current.phase !== transition.state.phase ||
          current.version !== transition.state.version ||
          !shouldDeliverMacOSNotification({
            settings: deliverySettings,
            event: transition.event,
            windowFocused,
          })
        ) {
          return;
        }

        await bridge.show({
          environmentId: transition.state.target.environmentId,
          threadId: transition.state.target.threadId,
          event: transition.event,
          projectTitle: transition.state.projectTitle,
          threadTitle: transition.state.threadTitle,
          allowWhileFocused: macOSNotificationAllowsFocusedDelivery(
            deliverySettings,
            transition.event,
          ),
        });
      });
    }
  }, [bridge, enqueueNotificationOperation, observed, settingsHydrated, shellsBootstrapped]);

  return null;
}
