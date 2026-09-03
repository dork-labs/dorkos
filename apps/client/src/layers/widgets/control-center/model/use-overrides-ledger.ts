/**
 * The Control Center's honesty ledger, composed entirely from queries that
 * already exist — no new server endpoint (spec `full-power-defaults`, D7).
 *
 * The global dial sets where NEW sessions start. Everything that does NOT simply
 * follow it belongs here so a person can see it and reach it: a runtime with its
 * own default, a live session bound to a different stop, and any task or
 * integration running at a power that diverges from the global one.
 *
 * ## Divergence, not a full inventory
 *
 * Every row is something whose trust STOP differs from the global stop. Listing
 * every task and every binding regardless would drown the signal — the ledger is
 * the exceptions, not the census. Divergence is read from what each runtime
 * declared about the mode (`resolveTrustStops`), never a mode-id table, so a
 * runtime that spells its stops differently is still judged correctly.
 *
 * ## The runtime a task or binding runs on
 *
 * Neither record carries a runtime; both are handled by the Claude Code adapter
 * today (the same assumption the task and binding forms make and document). So
 * their modes are resolved against Claude Code's profile. The day either grows a
 * second runtime, resolve it from the record rather than widening this constant.
 *
 * @module widgets/control-center/model/use-overrides-ledger
 */
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import { createModalHandoff, permissionModeLabel } from '@/layers/shared/lib';
import { stopLabel } from '@/layers/shared/ui';
import {
  useAppStore,
  useSafeNavigate,
  useOpenConnections,
  useSettingsDeepLink,
} from '@/layers/shared/model';
import { useConfig } from '@/layers/entities/config';
import { useRuntimeCapabilities, getRuntimeDescriptor } from '@/layers/entities/runtime';
import { useSessions } from '@/layers/entities/session';
import { useTasks, useTasksEnabled } from '@/layers/entities/tasks';
import { useBindings } from '@/layers/entities/binding';

/** The runtime a task's or a binding's turns actually run on today. */
const UNATTENDED_RUNTIME = 'claude-code';

/** Which surface an override row belongs to. */
export type OverrideKind = 'runtime' | 'session' | 'task' | 'binding';

/** One line in the overrides ledger. */
export interface OverrideRow {
  /** Stable render key. */
  key: string;
  /** Which surface owns it. */
  kind: OverrideKind;
  /** What a person calls this thing. */
  name: string;
  /** The power it runs at, in the runtime's own word for the mode. */
  detail: string;
  /** Open the owning surface, or `null` where there is nowhere to navigate (the embed). */
  onOpen: (() => void) | null;
}

/** What {@link useOverridesLedger} hands back. */
export interface OverridesLedger {
  /** Every override, runtimes first, then sessions, tasks and bindings. */
  rows: OverrideRow[];
  /** True once resolved and nothing diverges — the calm empty state. */
  isEmpty: boolean;
  /**
   * True while the runtime profiles or the config are still loading. Divergence
   * cannot be judged yet, so the surface shows a quiet loading line rather than
   * an empty state it might have to take back a beat later.
   */
  isResolving: boolean;
}

/**
 * Compose the overrides ledger from the config, sessions, tasks, bindings and
 * runtime-capability queries.
 *
 * Live sessions come from the current-workspace sessions query — the one that
 * already exists — so the ledger reports divergent sessions in the project a
 * person is looking at, without fetching every session on every route.
 */
export function useOverridesLedger(): OverridesLedger {
  const { data: config } = useConfig();
  const { data: capabilityMap } = useRuntimeCapabilities();
  const { sessions } = useSessions();
  const tasksEnabled = useTasksEnabled();
  const { data: tasks } = useTasks(tasksEnabled);
  const { data: bindings } = useBindings();
  const navigate = useSafeNavigate();
  const { open: openSettings } = useSettingsDeepLink();
  const openConnections = useOpenConnections();
  const setControlCenterOpen = useAppStore((s) => s.setControlCenterOpen);

  // Close the flyout BEFORE navigating or opening another surface — the
  // `pointer-events: none` hazard `createModalHandoff` documents. This used to
  // be spelled inline here; the Remote-access row and the beacon's flyout are
  // the same shape (DOR-1743), so the ordering lives in one place now.
  const openAndClose = createModalHandoff(() => setControlCenterOpen(false));

  const isResolving = capabilityMap === undefined || config === undefined;

  const defaults = config?.executionDefaults;
  const defaultRuntime = defaults?.runtime ?? UNATTENDED_RUNTIME;
  const defaultModes = capabilityMap?.capabilities[defaultRuntime]?.permissionModes;
  // What a stored `null` global stop actually resolves to — the default
  // runtime's own starting mode. The same chain Settings → Runtimes resolves.
  const runtimeDefaultStop: PermissionStop =
    defaultModes?.values.find((m) => m.id === defaultModes.default)?.stop ?? 'ask';
  const globalStop: PermissionStop = defaults?.trustStop ?? runtimeDefaultStop;

  const rows: OverrideRow[] = [];

  if (!isResolving) {
    // 1. Runtimes whose own default stop diverges from the global stop. A
    //    per-runtime override set to the SAME stop as the global default is not
    //    an exception, so it must not be listed as one — the same divergence
    //    rule the session/task/binding branches below apply.
    for (const entry of defaults?.perRuntime ?? []) {
      if (entry.trustStop === null || entry.trustStop === globalStop) continue;
      rows.push({
        key: `runtime:${entry.runtime}`,
        kind: 'runtime',
        name: getRuntimeDescriptor(entry.runtime).label,
        detail: stopLabel(entry.trustStop),
        onOpen: navigate ? openAndClose(() => openSettings('runtimes')) : null,
      });
    }

    // 2. Live sessions bound to a different stop than the global one.
    //
    // A session at a mode its runtime does not declare (`stop` is undefined) is
    // skipped, not listed: with no descriptor its position on the dial is
    // unknown, so its divergence cannot be judged here. The same holds for the
    // task and binding branches below. This is a rare case — a mode a runtime
    // dropped — and the honest fix, if it ever matters, is an explicit "unknown
    // mode" row in a follow-up, not a guessed stop.
    for (const session of sessions) {
      const modes = capabilityMap?.capabilities[session.runtime]?.permissionModes;
      const descriptor = modes?.values.find((m) => m.id === session.permissionMode);
      const stop = descriptor?.stop;
      if (!stop || stop === globalStop) continue;
      rows.push({
        key: `session:${session.id}`,
        kind: 'session',
        name: session.title || 'Untitled session',
        detail: descriptor?.label ?? permissionModeLabel(session.permissionMode),
        onOpen: navigate
          ? openAndClose(() =>
              navigate({ to: '/session', search: { session: session.id, dir: session.cwd } })
            )
          : null,
      });
    }

    // Tasks and bindings both run on the unattended runtime today.
    const unattendedModes =
      capabilityMap?.capabilities[UNATTENDED_RUNTIME]?.permissionModes?.values ?? [];

    // 3. Tasks whose mode diverges from the global stop.
    for (const task of tasks ?? []) {
      const descriptor = unattendedModes.find((m) => m.id === task.permissionMode);
      const stop = descriptor?.stop;
      if (!stop || stop === globalStop) continue;
      rows.push({
        key: `task:${task.id}`,
        kind: 'task',
        name: task.displayName ?? task.name,
        detail: descriptor?.label ?? permissionModeLabel(task.permissionMode),
        onOpen: navigate ? openAndClose(() => navigate({ to: '/tasks' })) : null,
      });
    }

    // 4. Bindings whose mode diverges from the global stop.
    for (const binding of bindings ?? []) {
      const descriptor = unattendedModes.find((m) => m.id === binding.permissionMode);
      const stop = descriptor?.stop;
      if (!stop || stop === globalStop) continue;
      rows.push({
        key: `binding:${binding.id}`,
        kind: 'binding',
        name: binding.label || binding.adapterId,
        detail: descriptor?.label ?? permissionModeLabel(binding.permissionMode),
        onOpen: navigate ? openAndClose(() => openConnections('messaging')) : null,
      });
    }
  }

  return { rows, isEmpty: !isResolving && rows.length === 0, isResolving };
}
