/**
 * This person, as others see their cursor in a live doc (DOR-2984): the name
 * and colour the app already draws for them on the team roster.
 *
 * @module features/docs/model/use-live-doc-user
 */
import { useMemo } from 'react';
import { OPERATOR_FALLBACK_DISPLAY_NAME } from '@dorkos/shared/team-schemas';
import { teamMemberFace, useTeamRoster } from '@/layers/entities/team';
import { FALLBACK_COLLABORATOR_COLOR, toHexColor } from '../lib/collaborator-color';
import type { LiveDocUser } from './use-live-doc';

/** The person at the keyboard's name and cursor colour. */
export function useLiveDocUser(): LiveDocUser {
  const roster = useTeamRoster();
  const self = roster.data?.members.find((member) => member.isSelf);
  return useMemo(
    () => ({
      name: self?.displayName ?? OPERATOR_FALLBACK_DISPLAY_NAME,
      color: self ? toHexColor(teamMemberFace(self).color) : FALLBACK_COLLABORATOR_COLOR,
    }),
    [self]
  );
}
