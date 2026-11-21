import { expect, it } from 'vitest';
import { isPersonBrowserOpen } from '../person-profile.js';

it('admits only person-alone opens to the existing embedded partition', () => {
  expect(isPersonBrowserOpen({ sessionId: null, profileId: null })).toBe(true);
  expect(isPersonBrowserOpen({ sessionId: 'atlas-chat', profileId: 'agent-atlas' })).toBe(false);
  expect(isPersonBrowserOpen({ sessionId: 'atlas-chat', profileId: null })).toBe(false);
  expect(isPersonBrowserOpen({ sessionId: null, profileId: 'agent-atlas' })).toBe(false);
  expect(isPersonBrowserOpen({})).toBe(false);
});
