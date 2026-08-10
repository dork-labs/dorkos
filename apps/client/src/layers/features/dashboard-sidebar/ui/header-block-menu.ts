/**
 * The header block's menu, as data.
 *
 * Its own module rather than a function inside `SidebarHeaderBlock`, for the
 * reason BC-43 exists: this list is meant to GROW. When communities ship they
 * arrive as additional rows here — the menu gets longer and nothing outside it
 * relayouts. Keeping the list behind one seam is what lets that claim be tested
 * (`SidebarHeaderBlock.test.tsx` renders the block against a short list and a
 * long one and compares the block's own markup) instead of asserted in prose.
 *
 * @module features/dashboard-sidebar/ui/header-block-menu
 */
import { RefreshCw, Settings, UserRound } from 'lucide-react';
import type { SidebarMenuNode } from '@/layers/shared/ui';

/** What the header block's menu needs in order to say what it says. */
export interface HeaderBlockMenuModel {
  /** Open the settings dialog. */
  onOpenSettings: () => void;
  /**
   * Open your own profile, or `null` when the roster names nobody yet.
   *
   * Absent rather than inert, the same choice `AccountMenuContainer` makes: the
   * row's whole content is your name and your handle, so with no identity
   * behind it there is nothing for it to open.
   */
  onOpenAccount: (() => void) | null;
  /**
   * This build's version, or `null` while the server config is still in flight.
   *
   * This is the version number's ONE home in the chrome (BC-44) — the footer's
   * version row goes away with the footer strip in P2.5.
   */
  version: string | null;
  /** A dev build says so instead of showing a number nobody can update to. */
  isDevMode: boolean;
  /** Ask the server whether a newer release exists, and say what it found. */
  onCheckForUpdates: () => void;
}

/**
 * Build the header block's items, in order.
 *
 * Places first, then the quiet version line at the bottom — the same shape
 * every other menu in this sidebar follows (what you can do, then what this
 * thing is).
 *
 * @param model - The actions plus the build's own facts.
 */
export function buildHeaderBlockMenuNodes(model: HeaderBlockMenuModel): SidebarMenuNode[] {
  const nodes: SidebarMenuNode[] = [
    {
      kind: 'action',
      id: 'workspace-settings',
      // The one place this sidebar says "workspace": it names the existing
      // settings surface. Everywhere else the repo/cwd dimension is a
      // "project" (spec §16, R4).
      label: 'Workspace settings',
      icon: Settings,
      opensInput: true,
      run: model.onOpenSettings,
    },
  ];

  if (model.onOpenAccount !== null) {
    nodes.push({
      kind: 'action',
      id: 'account',
      label: 'Account',
      icon: UserRound,
      opensInput: true,
      run: model.onOpenAccount,
    });
  }

  if (model.isDevMode) {
    nodes.push({ kind: 'separator', id: 'sep-version' });
    nodes.push({ kind: 'note', id: 'version', icon: RefreshCw, text: 'Development build' });
    return nodes;
  }

  if (model.version !== null) {
    nodes.push({ kind: 'separator', id: 'sep-version' });
    nodes.push({
      kind: 'action',
      id: 'version',
      label: `v${model.version} beta`,
      icon: RefreshCw,
      opensInput: false,
      hint: 'Check for updates',
      run: model.onCheckForUpdates,
    });
  }

  return nodes;
}
