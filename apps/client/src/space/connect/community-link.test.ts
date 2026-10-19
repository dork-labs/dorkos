import { describe, expect, it } from 'vitest';
import { communityLink } from './community-link.js';

describe('communityLink', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  it('uses the short address when there is one', () => {
    expect(communityLink('https://spaces.example.com', id, 'acme')).toBe(
      'https://spaces.example.com/acme'
    );
  });
  it('falls back to the community’s own /c/ address', () => {
    expect(communityLink('https://spaces.example.com', id, null)).toBe(
      `https://spaces.example.com/c/${id}`
    );
    expect(communityLink('https://spaces.example.com', id, undefined)).toBe(
      `https://spaces.example.com/c/${id}`
    );
  });
});
