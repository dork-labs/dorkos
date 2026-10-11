/**
 * The conduct cases of the `CommunityAdapter` conformance suite: a member's own standing, the
 * rules they accept, the name they choose, and the messages they report. Each is branched on
 * the `conduct` or `reports` capability, and both sides prove something: an off backend refuses
 * every one of them (U13 holds that, and that the refusal writes nothing), and an on backend
 * answers in the port's shapes and never stretches an acceptance to rules nobody read.
 *
 * @module test-utils/community-conformance-conduct
 */
import { describe, expect, it } from 'vitest';
import {
  CommunityMemberSchema,
  CommunityStandingSchema,
  CommunityUnsupportedError,
} from '@dorkos/shared/community-adapter';
import type { CommunityConformanceContext } from './community-conformance-support.js';

/**
 * Register the conduct cases.
 *
 * @param ctx - The suite's resolved hooks and helpers.
 */
export function registerConductAssertions(ctx: CommunityConformanceContext): void {
  const { makeAdapter, arrange } = ctx;
  // Read once at registration, so a backend without the capability registers a named skip.
  const declared = makeAdapter().getCapabilities();

  describe('conduct', () => {
    if (declared.conduct) {
      it('C21 reads a well-formed standing and never accepts rules in a version that is not current', async () => {
        const { adapter, roomId, identityMemberId } = await arrange();
        const standing = CommunityStandingSchema.parse(await adapter.getStanding(roomId));
        expect(
          standing.rules.acceptedVersion,
          'nobody can have accepted a version that does not exist yet'
        ).toBeLessThanOrEqual(standing.rules.version);

        // One past the current version is rules nobody has read: always refused.
        await expect(adapter.acceptRules(standing.rules.version + 1)).rejects.toBeDefined();
        const after = CommunityStandingSchema.parse(await adapter.getStanding(roomId));
        expect(after.rules.acceptedVersion, 'a refused acceptance changes nothing').toBe(
          standing.rules.acceptedVersion
        );

        // Renaming is the connected person's own act, and answers as them.
        const self = (await adapter.listMembers(roomId)).find(
          (member) => member.memberId === identityMemberId
        );
        const renamed = CommunityMemberSchema.parse(
          await adapter.setDisplayName(self?.displayName ?? 'Conformance Probe')
        );
        expect(renamed.memberId, 'a rename names the connected person').toBe(identityMemberId);
        expect(renamed.kind, 'only a person renames through this port').toBe('human');
      });
    } else {
      it.skip('C21 standing, rules and display name (this backend declares no conduct)', () => {});
    }

    if (declared.reports) {
      it('C22 refuses a report of a message that is not there, without claiming reports are off', async () => {
        const { adapter, roomId } = await arrange();
        const refused = adapter.reportEntry(roomId, 'absent-entry', { reason: 'spam' });
        await expect(refused).rejects.toBeDefined();
        await expect(refused).rejects.not.toBeInstanceOf(CommunityUnsupportedError);
      });
    } else {
      it.skip('C22 reports (this backend declares no reports)', () => {});
    }
  });
}
