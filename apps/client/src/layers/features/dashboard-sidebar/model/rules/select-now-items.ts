/**
 * What is allowed into Heads up — four things, and the model has no branch that can
 * add a fifth (BC-5).
 *
 * @module features/dashboard-sidebar/model/rules/select-now-items
 */
import type { NowKind, SidebarIconId, SidebarRowModel } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';
import { rowKey } from './targets';

/**
 * The only four blockages that may enter Heads up.
 *
 * **An allowlist, not a filter on an exclusion list.** Mentions, DMs, unread
 * channels, automated-session activity and update-ready notices are kept out by
 * construction rather than by a rule somebody could relax: diluting Heads up with
 * social signals is how a person learns to ignore it (design-decisions §18).
 */
const NOW_KINDS: readonly NowKind[] = ['permission-prompt', 'question', 'error', 'idle-timeout'];

/** The mark each blockage draws in the glyph slot. */
const NOW_ICON: Record<NowKind, SidebarIconId> = {
  'permission-prompt': 'permission',
  question: 'question',
  error: 'error',
  'idle-timeout': 'idle',
};

/**
 * The rows Heads up would show if it had no cap — one per thing that needs the
 * operator, in the order the signals arrived.
 *
 * Every row here has `target.kind === 'attention'`, which is what makes BC-21
 * true by construction: the open conversation is a `session` target, so it can
 * never be one of these however blocked it is. A permission prompt raised BY
 * the open conversation still belongs here — it needs you, and where you happen
 * to be standing does not change that.
 *
 * @param state - The snapshot.
 */
export function selectNowItems(state: SidebarState): SidebarRowModel[] {
  const rows: SidebarRowModel[] = [];
  for (const signal of state.attention) {
    if (!NOW_KINDS.includes(signal.kind)) continue;
    const target = {
      kind: 'attention',
      signalId: signal.id,
      deepLink: signal.deepLink,
    } as const;
    rows.push({
      key: rowKey(target),
      target,
      glyph: signal.agentPath
        ? { kind: 'agent-avatar', agentPath: signal.agentPath }
        : { kind: 'icon', icon: NOW_ICON[signal.kind] },
      primary: signal.primary,
      ...(signal.secondary === undefined ? {} : { secondary: signal.secondary }),
      reservesVerbLine: false,
      unread: { tier: 'none' },
      attention: { kind: signal.kind, since: signal.since, dismissible: signal.dismissible },
      muted: false,
      draggable: false,
      reason: `now:${signal.kind}`,
    });
  }
  return rows;
}
