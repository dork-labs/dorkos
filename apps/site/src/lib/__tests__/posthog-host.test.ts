/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import { deriveAssetHost, deriveUiHost } from '../posthog-host';

describe('deriveAssetHost', () => {
  it('derives the US assets host from the US ingest host', () => {
    expect(deriveAssetHost('https://us.i.posthog.com')).toBe('https://us-assets.i.posthog.com');
  });

  it('derives the EU assets host from the EU ingest host', () => {
    expect(deriveAssetHost('https://eu.i.posthog.com')).toBe('https://eu-assets.i.posthog.com');
  });

  it('tolerates a trailing slash on the ingest host', () => {
    expect(deriveAssetHost('https://eu.i.posthog.com/')).toBe('https://eu-assets.i.posthog.com');
  });

  it('falls back to the ingest host itself for a custom/self-hosted host', () => {
    expect(deriveAssetHost('https://posthog.example.com')).toBe('https://posthog.example.com');
    expect(deriveAssetHost('http://localhost:4599')).toBe('http://localhost:4599');
  });

  it('does not treat lookalike hosts as PostHog regions', () => {
    expect(deriveAssetHost('https://us.i.posthog.com.evil.example')).toBe(
      'https://us.i.posthog.com.evil.example'
    );
  });
});

describe('deriveUiHost', () => {
  it('derives the US UI host from the US ingest host', () => {
    expect(deriveUiHost('https://us.i.posthog.com')).toBe('https://us.posthog.com');
  });

  it('derives the EU UI host from the EU ingest host', () => {
    expect(deriveUiHost('https://eu.i.posthog.com')).toBe('https://eu.posthog.com');
  });

  it('tolerates a trailing slash on the ingest host', () => {
    expect(deriveUiHost('https://us.i.posthog.com/')).toBe('https://us.posthog.com');
  });

  it('defaults to the US UI host for a custom/self-hosted host', () => {
    expect(deriveUiHost('https://posthog.example.com')).toBe('https://us.posthog.com');
    expect(deriveUiHost('http://localhost:4599')).toBe('https://us.posthog.com');
  });
});
