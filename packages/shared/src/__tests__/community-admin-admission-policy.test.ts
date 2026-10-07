import { describe, expect, it } from 'vitest';
import { CommunityAdminAdmissionPolicySchema } from '../community-admin-wire.js';

describe('CommunityAdminAdmissionPolicySchema', () => {
  it('accepts the open policy beside the two older ones', () => {
    for (const policy of ['invite_only', 'closed', 'open']) {
      expect(CommunityAdminAdmissionPolicySchema.parse(policy)).toBe(policy);
    }
  });

  it('still refuses a policy nobody defined', () => {
    expect(CommunityAdminAdmissionPolicySchema.safeParse('public').success).toBe(false);
  });
});
