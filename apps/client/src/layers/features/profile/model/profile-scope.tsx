/**
 * Which panel a profile is being drawn in, and whose it is (spec
 * `profile-unification` §1.6).
 *
 * Two profiles can be on screen at once: the docked one for the session you are
 * in, and a sheet over it for somebody else. Anything that would otherwise be
 * "the profile" as a global — the face's shared-layout id, the count of
 * unsaved editors — has to be told WHICH one, or the two quietly reach into
 * each other: one identity's face flying across the screen into the other's, a
 * half-written SOUL.md in the sheet refusing to let the panel close.
 *
 * Ambient rather than a prop because every consumer sits several components
 * below the one place that knows the answer — `ProfileView` — and nothing in
 * between has an opinion about it.
 *
 * @module features/profile/model/profile-scope
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';

/** One panel drawing one identity. */
export interface ProfileScopeValue {
  /** Which home is drawing it. */
  home: 'docked' | 'sheet';
  /** Whose profile is on screen — the stack's current subject, not its root. */
  memberId: string;
}

const ProfileScopeContext = createContext<ProfileScopeValue | null>(null);

/**
 * The scope as one string, for a keyed map or a `layoutId`.
 *
 * @param scope - The panel and identity, or `null` outside any profile.
 * @returns The key, or `null` when there is no scope to key on.
 */
export function profileScopeKey(scope: ProfileScopeValue | null): string | null {
  return scope === null ? null : `${scope.home}:${scope.memberId}`;
}

export interface ProfileScopeProps extends ProfileScopeValue {
  children: ReactNode;
}

/**
 * Name the panel and identity everything beneath belongs to.
 *
 * A profile rendered outside a scope (a showcase, a unit test of one page)
 * simply has none: its face does not animate between frames, and its editors
 * register their unsaved work nowhere. Both are the right degraded answer —
 * a shared layout id promises a second face that does not exist, and a leave
 * guard nobody can ask is a question nobody will be shown.
 */
export function ProfileScope({ home, memberId, children }: ProfileScopeProps) {
  // Stable per (home, member) or every render would restart the face's layout
  // animation.
  const value = useMemo(() => ({ home, memberId }), [home, memberId]);
  return <ProfileScopeContext.Provider value={value}>{children}</ProfileScopeContext.Provider>;
}

/** The panel and identity this component is being drawn inside, if any. */
export function useProfileScope(): ProfileScopeValue | null {
  return useContext(ProfileScopeContext);
}
