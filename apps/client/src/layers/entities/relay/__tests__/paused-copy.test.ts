import { describe, expect, it } from 'vitest';
import type { AdapterConfirmation } from '@dorkos/shared/relay-schemas';
import {
  pausedConfirmHint,
  pausedMeta,
  pausedNotSent,
  pausedReferenceList,
  pausedRowHint,
  pausedRowMeta,
} from '../lib/paused-copy';

const base = (refs: string[], host?: string): AdapterConfirmation => ({
  references: refs.map((ref, i) => ({ field: `f${i}`, ref })),
  ...(host ? { host } : {}),
  fingerprint: 'fp',
  notSent: 0,
});

describe('paused-copy', () => {
  it('names one, two, or a count of settings, and the host', () => {
    expect(pausedMeta('Webhook', base(['env:A'], 'hooks.example.dev'))).toBe(
      'Webhook · sends env:A to hooks.example.dev'
    );
    expect(pausedMeta('Webhook', base(['env:A', 'keychain:B'], 'h.dev'))).toBe(
      'Webhook · sends env:A and keychain:B to h.dev'
    );
    expect(pausedMeta('Webhook', base(['env:A', 'env:B', 'env:C'], 'h.dev'))).toBe(
      'Webhook · sends 3 settings to h.dev'
    );
    expect(pausedReferenceList(base(['env:A', 'env:B', 'env:C']))).toBe('env:A, env:B, env:C');
    expect(pausedMeta('Telegram', base(['env:A']))).toBe('Telegram · sends env:A');
  });

  it('says what Confirm lets it do, by name', () => {
    expect(pausedConfirmHint(base(['env:DEPLOY_TOKEN'], 'hooks.example.dev'))).toBe(
      'Lets it send DEPLOY_TOKEN to hooks.example.dev again. Not yours? Open it and remove it.'
    );
  });

  it('counts dropped messages: none, singular, plural, capped at 99+', () => {
    expect(pausedNotSent(0)).toBeUndefined();
    expect(pausedNotSent(1)).toBe('1 message not sent while paused');
    expect(pausedNotSent(3)).toBe('3 messages not sent while paused');
    expect(pausedNotSent(100)).toBe('99+ messages not sent while paused');
  });

  it('says the Needs you row in its own words', () => {
    expect(pausedRowMeta('Webhook', base(['env:DEPLOY_TOKEN'], 'hooks.example.dev'))).toBe(
      'Webhook · env:DEPLOY_TOKEN → hooks.example.dev'
    );
    expect(pausedRowHint(base(['env:DEPLOY_TOKEN'], 'hooks.example.dev'))).toBe(
      'Lets it send DEPLOY_TOKEN to hooks.example.dev again. Nothing else changes.'
    );
  });
});
