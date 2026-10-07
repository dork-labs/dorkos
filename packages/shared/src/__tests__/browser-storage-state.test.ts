import { expect, it } from 'vitest';
import {
  BrowserProductionProfileImportRequestSchema,
  BrowserOpenRequestSchema,
} from '../browser-schemas.js';
const state = {
  cookies: [],
  origins: [
    {
      origin: 'https://owned.example',
      localStorage: [{ name: 'session', value: 'fixture-value' }],
    },
  ],
};
const request = {
  requestId: 'request_original_reference_0001',
  workspaceId: 'workspace_owned_reference_0001',
  label: 'Imported',
  storageState: state,
};
it('accepts bounded explicit cookie/local storage only without an existing destination', () => {
  expect(BrowserProductionProfileImportRequestSchema.parse(request)).toEqual(request);
  expect(
    BrowserProductionProfileImportRequestSchema.safeParse({
      ...request,
      profileId: 'profile_existing_reference_0001',
    }).success
  ).toBe(false);
  expect(
    BrowserOpenRequestSchema.safeParse({
      requestId: request.requestId,
      mode: 'ephemeral',
      storageState: state,
    }).success
  ).toBe(false);
});
it.each(['credentials', 'indexedDB', 'profileDir'])('refuses unsupported state %s', (key) => {
  expect(
    BrowserProductionProfileImportRequestSchema.safeParse({
      ...request,
      storageState: { ...state, [key]: [] },
    }).success
  ).toBe(false);
});
it.each([
  'file:///tmp/private',
  'https://user:secret@owned.example',
  'https://owned.example/path',
  'data:text/plain,hello',
])('refuses non-origin/credential-bearing state %s', (origin) => {
  expect(
    BrowserProductionProfileImportRequestSchema.safeParse({
      ...request,
      storageState: { cookies: [], origins: [{ origin, localStorage: [] }] },
    }).success
  ).toBe(false);
});
it('refuses duplicate origins, local storage keys and oversized state', () => {
  expect(
    BrowserProductionProfileImportRequestSchema.safeParse({
      ...request,
      storageState: { ...state, origins: [...state.origins, ...state.origins] },
    }).success
  ).toBe(false);
  expect(
    BrowserProductionProfileImportRequestSchema.safeParse({
      ...request,
      storageState: {
        cookies: [],
        origins: [
          {
            origin: 'https://owned.example',
            localStorage: [
              { name: 'a', value: 'b' },
              { name: 'a', value: 'c' },
            ],
          },
        ],
      },
    }).success
  ).toBe(false);
  expect(
    BrowserProductionProfileImportRequestSchema.safeParse({
      ...request,
      storageState: {
        cookies: [],
        origins: [
          {
            origin: 'https://owned.example',
            localStorage: Array.from({ length: 8 }, (_, i) => ({
              name: String(i),
              value: 'a'.repeat(4096),
            })),
          },
        ],
      },
    }).success
  ).toBe(false);
});
it('refuses accessors before evaluating any imported secret producer', () => {
  let reads = 0;
  const invalid = { ...request };
  Object.defineProperty(invalid, 'storageState', {
    enumerable: true,
    get() {
      reads++;
      return state;
    },
  });
  expect(BrowserProductionProfileImportRequestSchema.safeParse(invalid).success).toBe(false);
  expect(reads).toBe(0);
});
