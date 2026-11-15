import { describe, expect, it } from 'vitest';
import { docsUrl, links, repoUrl, siteUrl } from '../links.js';

describe('links', () => {
  it('pins the Cloud API, repository and docs to their exact addresses', () => {
    expect(links).toMatchObject({
      cloudApi: 'https://cloud.dorkos.ai',
      repo: 'https://github.com/dork-labs/dorkos',
      docs: 'https://dorkos.ai/docs',
    });
  });

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
