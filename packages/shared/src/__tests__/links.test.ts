import { describe, expect, it } from 'vitest';
import { docsUrl, repoUrl, siteUrl } from '../links.js';

describe('links', () => {
  it('joins paths with exactly one slash', () => {
    expect(siteUrl()).toBe('https://dorkos.ai');
    expect(siteUrl('/telemetry')).toBe('https://dorkos.ai/telemetry');
    expect(siteUrl('telemetry')).toBe('https://dorkos.ai/telemetry');
    expect(siteUrl('?ref=x')).toBe('https://dorkos.ai?ref=x');
    expect(docsUrl('/guides/cli-usage#agent-files')).toBe(
      'https://dorkos.ai/docs/guides/cli-usage#agent-files'
    );
    expect(repoUrl('/issues')).toBe('https://github.com/dork-labs/dorkos/issues');
  });
});
