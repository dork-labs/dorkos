/**
 * The one face the profile draws — big in the portrait, small in a pushed
 * page's strip, and the same disc travelling between them (spec
 * `profile-unification` §1.3, motion).
 *
 * @module features/profile/ui/ProfileFace
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { IdentityAvatar } from '@/layers/shared/ui';
import { teamMemberFace } from '@/layers/entities/team';

/**
 * The shared-layout id the portrait and the strip share.
 *
 * One PROFILE has exactly one face on screen at a time, which is what makes the
 * portrait *shrink into* the strip rather than one disc vanishing while another
 * appears somewhere else. But the app can have two profiles up at once — the
 * docked profile of the session you are in, and a sheet over it for somebody
 * else — and a single global id would have `motion` fly one identity's face
 * across the screen into the other's. Scoping by home and by subject keeps each
 * profile's face travelling only within its own panel.
 */
function faceLayoutId(scope: ProfileFaceScopeValue | null): string | undefined {
  return scope === null ? undefined : `profile-face:${scope.home}:${scope.memberId}`;
}

/** Which panel, and whose profile, the faces below belong to. */
interface ProfileFaceScopeValue {
  home: 'docked' | 'sheet';
  memberId: string;
}

/**
 * Ambient rather than a prop because every face inside one profile shares it and
 * nothing between them decides it — `ProfileView` establishes it once.
 */
const FaceScopeContext = createContext<ProfileFaceScopeValue | null>(null);

export interface ProfileFaceScopeProps extends ProfileFaceScopeValue {
  children: ReactNode;
}

/**
 * Name the panel every {@link ProfileFace} beneath belongs to.
 *
 * A face rendered outside a scope (a showcase, a test) simply does not animate
 * between frames — which is right: with nothing to travel to, a shared layout id
 * is a promise about a second face that does not exist.
 */
export function ProfileFaceScope({ home, memberId, children }: ProfileFaceScopeProps) {
  // The object identity has to be stable per (home, member) or every render
  // would restart the layout animation.
  const value = useMemo(() => ({ home, memberId }), [home, memberId]);
  return <FaceScopeContext.Provider value={value}>{children}</FaceScopeContext.Provider>;
}

/** How long the portrait takes to become the strip. Position only, ~250 ms. */
const FACE_TRANSITION = { duration: 0.25, ease: [0.4, 0, 0.2, 1] } as const;

export interface ProfileFaceProps {
  /** Whose face. */
  member: TeamMember;
  /** `lg` in the portrait, `sm` in a page's strip. */
  size: 'lg' | 'sm';
  /** Wrapper classes — the portrait uses this for its own press affordance. */
  className?: string;
}

/**
 * Draw an identity's disc, tracked across the push so it travels.
 *
 * **`motion` bypasses the global reduced-motion reset** (it writes inline
 * styles from JS), so this branches on `useReducedMotion` and renders a plain
 * disc when the preference is set — off, not shortened. The face still ends up
 * in the right place; it simply gets there without the flight.
 */
export function ProfileFace({ member, size, className }: ProfileFaceProps) {
  const face = teamMemberFace(member);
  const reduced = useReducedMotion();
  const scope = useContext(FaceScopeContext);

  const avatar = (
    <IdentityAvatar
      size={size}
      kind={face.kind}
      color={face.color}
      emoji={face.emoji}
      imageUrl={face.imageUrl}
      fallback={face.fallback}
      origin={face.origin}
    />
  );

  if (reduced) return <span className={className}>{avatar}</span>;

  return (
    <motion.span
      layoutId={faceLayoutId(scope)}
      transition={FACE_TRANSITION}
      className={className}
      style={{ display: 'inline-flex' }}
    >
      {avatar}
    </motion.span>
  );
}
