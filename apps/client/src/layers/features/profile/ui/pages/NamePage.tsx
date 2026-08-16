/**
 * Name — your display name, on its own page (spec `profile-unification` §1.5).
 *
 * @module features/profile/ui/pages/NamePage
 */
import { ProfileNameField } from '../fields/ProfileFields';
import type { ProfilePageContentProps } from './types';

/** The one field, the same one Settings › Profile draws. */
export function NamePage({ member }: ProfilePageContentProps) {
  return <ProfileNameField member={member} />;
}
