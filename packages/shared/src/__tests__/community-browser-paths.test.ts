import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_SETTINGS_SECTIONS,
  communitySettingsPath,
  isCommunityInvitationUrl,
  parseCommunitySettingsPath,
} from '../community-wire.js';

const ID = '5b0c6f7e-8a51-4c1e-9d0e-2f3a4b5c6d7e';

describe('Community settings paths', () => {
  it('round-trips every section and the default', () => {
    expect(parseCommunitySettingsPath(communitySettingsPath(ID))).toEqual({ section: null });
    for (const section of COMMUNITY_SETTINGS_SECTIONS)
      expect(parseCommunitySettingsPath(communitySettingsPath(ID, section))).toEqual({ section });
  });

  it('opens the default section for an unknown one rather than failing', () => {
    expect(parseCommunitySettingsPath(`/c/${ID}/settings/billing`)).toEqual({ section: null });
  });

  it('is not a settings path anywhere else', () => {
    for (const path of ['/', `/c/${ID}`, `/c/${ID}/join`, '/settings', `/c/${ID}/settings/a/b`])
      expect(parseCommunitySettingsPath(path)).toBeNull();
  });

  it('encodes the id so it cannot add a path segment', () => {
    expect(communitySettingsPath('a/b', 'account')).toBe('/c/a%2Fb/settings/account');
  });
});

describe('isCommunityInvitationUrl', () => {
  it('accepts the link a Community issues', () => {
    expect(isCommunityInvitationUrl(`https://community.example.com/c/${ID}/join#invite=abc`)).toBe(
      true
    );
    expect(isCommunityInvitationUrl('  http://localhost:8787/join#token=abc  ')).toBe(true);
  });

  it('refuses anything that is not an invitation', () => {
    for (const value of [
      '',
      'not a url',
      `https://community.example.com/c/${ID}/join`,
      `https://community.example.com/c/${ID}#invite=abc`,
      `javascript:alert(1)//join#invite=abc`,
      `ftp://community.example.com/join#invite=abc`,
      `https://community.example.com/c/${ID}/join?invite=abc`,
    ])
      expect(isCommunityInvitationUrl(value)).toBe(false);
  });
});
