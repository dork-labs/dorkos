/**
 * The person proofs this page sends (DOR-3330): its own step-up's, and in the
 * desktop app the window sign-in's, so whichever session the cookie is, one
 * of them matches it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PERSON_PROOF_STORAGE_KEY } from '@dorkos/shared/person-session';
import { readPersonProof, writePersonProof } from '../person-proof-store';

afterEach(() => {
  localStorage.clear();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('readPersonProof', () => {
  it('is nothing before any step-up', () => {
    expect(readPersonProof()).toBeNull();
  });

  it('is the proof the step-up left in this page', () => {
    writePersonProof('p-page');
    expect(localStorage.getItem(PERSON_PROOF_STORAGE_KEY)).toBe('p-page');
    expect(readPersonProof()).toBe('p-page');
  });

  it('carries the desktop window’s proof beside the page’s own', () => {
    (window as { electronAPI?: unknown }).electronAPI = { getPersonProof: () => 'p-shell' };
    expect(readPersonProof()).toBe('p-shell');
    writePersonProof('p-page');
    expect(readPersonProof()).toBe('p-page,p-shell');
  });
});
