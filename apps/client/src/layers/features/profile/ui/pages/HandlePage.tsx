/**
 * Handle — your `@handle`, on its own page (spec `profile-unification` §1.5).
 *
 * @module features/profile/ui/pages/HandlePage
 */
import { ProfileHandleField } from '../fields/ProfileFields';
import type { ProfilePageContentProps } from './types';

/** The one field, the same one Settings › Profile draws. */
export function HandlePage({ member }: ProfilePageContentProps) {
  return <ProfileHandleField member={member} />;
}
