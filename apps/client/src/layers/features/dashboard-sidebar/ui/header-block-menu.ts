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
 * The menu reads, top to bottom (DOR-2628): **you** (your face and name, onto
 * your profile), your **DorkOS account** (whether this computer is signed in,
 * onto its Settings tab), **Settings**, then the places you can switch to, then
 * the quiet version line. "Account" means one thing in it — the DorkOS account
 * — and your own identity is called you.
 *
 * @module features/dashboard-sidebar/ui/header-block-menu
 */
import type { ReactNode } from 'react';
import { CircleUserRound, RefreshCw, Settings, UserRound } from 'lucide-react';
import type { SidebarMenuNode } from '@/layers/shared/ui';

/** The "you" row: whose DorkOS this is. */
export interface HeaderBlockYou {
  /** Your display name, as the roster spells it. */
  name: string;
  /** Your face, drawn where the row's icon would go. */
  face: ReactNode;
  /** Open your own profile. */
  onOpen: () => void;
}

/** What the header block's identity rows need in order to say what they say. */
export interface HeaderBlockIdentityModel {
  /**
   * You, or `null` when the roster names nobody yet.
   *
   * Absent rather than inert, the same choice `AccountMenuContainer` makes: the
   * row's whole content is your face and your name, so with no identity behind
   * it there is nothing for it to open.
   */
  you: HeaderBlockYou | null;
  /**
   * The DorkOS account row's status line ("Not signed in", "Signed in ·
   * Dorian"), or `undefined` while it is still being read.
   */
  accountStatus: string | undefined;
  /** Open Settings › DorkOS account. */
  onOpenAccount: () => void;
  /** Open the settings dialog. */
  onOpenSettings: () => void;
}

/** What the version line needs. */
export interface HeaderBlockVersionModel {
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
 * Build the rows above the places you can switch to: you, your DorkOS
 * account, and Settings.
 *
 * @param model - Who you are, the account's status, and the two doors.
 */
export function buildHeaderBlockIdentityNodes(model: HeaderBlockIdentityModel): SidebarMenuNode[] {
  const nodes: SidebarMenuNode[] = [];

  if (model.you !== null) {
    nodes.push({
      kind: 'action',
      id: 'you',
      label: model.you.name,
      description: 'View profile',
      icon: UserRound,
      leading: model.you.face,
      // Opens a drawer and asks nothing, so no `…` — but the drawer takes
      // focus, so the close-focus guard still has to hold it.
      guardsFocus: true,
      run: model.you.onOpen,
    });
  }

  nodes.push(
    {
      kind: 'action',
      id: 'dorkos-account',
      label: 'DorkOS account',
      description: model.accountStatus,
      icon: CircleUserRound,
      guardsFocus: true,
      run: model.onOpenAccount,
    },
    {
      kind: 'action',
      id: 'settings',
      label: 'Settings',
      icon: Settings,
      guardsFocus: true,
      run: model.onOpenSettings,
    }
  );

  return nodes;
}

/**
 * Build the quiet version line at the bottom of the menu, behind its own rule.
 *
 * @param model - The build's own facts.
 */
export function buildHeaderBlockVersionNodes(model: HeaderBlockVersionModel): SidebarMenuNode[] {
  if (model.isDevMode) {
    return [
      { kind: 'separator', id: 'sep-version' },
      { kind: 'note', id: 'version', icon: RefreshCw, text: 'Development build' },
    ];
  }
  if (model.version === null) return [];
  return [
    { kind: 'separator', id: 'sep-version' },
    {
      kind: 'action',
      id: 'version',
      label: `v${model.version} beta`,
      icon: RefreshCw,
      opensInput: false,
      hint: 'Check for updates',
      run: model.onCheckForUpdates,
    },
  ];
}
