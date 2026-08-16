/**
 * Photo — your face, on its own page (spec `profile-unification` §1.5).
 *
 * @module features/profile/ui/pages/PhotoPage
 */
import { ProfilePhotoField } from '../fields/ProfileFields';
import type { ProfilePageContentProps } from './types';

/** The one field, the same one Settings › Profile draws. */
export function PhotoPage({ member }: ProfilePageContentProps) {
  return <ProfilePhotoField member={member} />;
}
