/**
 * Reading the one ticket or pull request a `session_start` brief names
 * (DOR-3690), and refusing to guess when the brief is ambiguous.
 */
import { describe, expect, it } from 'vitest';
import { inferClaimKey, inferWorkKey } from '../work-claim-infer.js';

describe('inferClaimKey', () => {
  it('reads a ticket id from the title', () => {
    expect(inferClaimKey({ title: 'DOR-1234: fix the flaky test' })).toBe('DOR-1234');
  });

  it('reads a ticket id from the reason', () => {
    expect(inferClaimKey({ reason: 'Build lane for DOR-77' })).toBe('DOR-77');
  });

  it('reads the first message when the title and reason name nothing', () => {
    expect(inferClaimKey({ title: 'Build lane', prompt: 'Build DOR-9 test-first.' })).toBe('DOR-9');
  });

  it('prefers the title and reason over the first message', () => {
    expect(
      inferClaimKey({ title: 'DOR-5 lane', prompt: 'Build DOR-5. Related: DOR-6, DOR-7.' })
    ).toBe('DOR-5');
  });

  it('reads pull requests only where the text says they are one', () => {
    expect(inferClaimKey({ title: 'Review PR #42' })).toBe('PR #42');
    expect(inferClaimKey({ title: 'pr 42 review' })).toBe('PR #42');
    expect(inferClaimKey({ title: 'Land acme/app#42' })).toBe('ACME/APP#42');
  });

  it('keys a pull request by its repo when the link names one, so repos never collide', () => {
    expect(inferClaimKey({ prompt: 'See https://github.com/acme/app/pull/42' })).toBe(
      'ACME/APP#42'
    );
    expect(inferClaimKey({ prompt: 'See https://github.com/acme/site/pull/42' })).toBe(
      'ACME/SITE#42'
    );
    expect(inferClaimKey({ title: 'Review /pull/42' })).toBe('PR #42');
  });

  it('says where it read the key, so a key only the first message names is told apart', () => {
    expect(inferWorkKey({ title: 'DOR-3 lane' })).toEqual({ key: 'DOR-3', from: 'brief' });
    expect(inferWorkKey({ prompt: 'Build DOR-3.' })).toEqual({ key: 'DOR-3', from: 'prompt' });
    expect(inferWorkKey({ prompt: 'Nothing here.' })).toBeNull();
  });

  it('never reads a bare #number, a heading or a colour as a pull request', () => {
    expect(inferClaimKey({ title: 'Item #42 on the list' })).toBeNull();
    expect(inferClaimKey({ prompt: 'Make the border #123 and add a ## heading' })).toBeNull();
  });

  it('ignores names that only look like tickets', () => {
    expect(inferClaimKey({ title: 'Switch to SHA-256 and UTF-8 with ISO-8601 dates' })).toBeNull();
  });

  it('infers nothing when the brief names two different pieces of work', () => {
    expect(inferClaimKey({ title: 'DOR-1 and DOR-2' })).toBeNull();
    expect(inferClaimKey({ title: 'Build lane', prompt: 'Do DOR-1, then PR #3.' })).toBeNull();
  });

  it('counts the same id written twice as one', () => {
    expect(inferClaimKey({ title: 'DOR-8', reason: 'finish DOR-8' })).toBe('DOR-8');
  });

  it('infers nothing from an empty brief', () => {
    expect(inferClaimKey({})).toBeNull();
    expect(inferClaimKey({ title: 'Tidy the docs', prompt: 'Make them shorter.' })).toBeNull();
  });
});
