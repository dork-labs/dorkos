import { describe, expect, it } from 'vitest';
import { docsUrl, links, repoUrl, siteUrl } from '../links.js';

describe('links', () => {
  it('names the site, docs and repositories', () => {
    expect(links.site).toBe('https://dorkos.ai');
    expect(links.docs).toBe('https://dorkos.ai/docs');
    expect(links.cloudApi).toBe('https://cloud.dorkos.ai');
    expect(links.repo).toBe('https://github.com/dork-labs/dorkos');
    expect(links.repo).toBe(`https://github.com/${links.repoSlug}`);
    expect(links.marketplaceRepo).toBe(`https://github.com/${links.marketplaceRepoSlug}`);
    expect(links.docs.startsWith(`${links.site}/`)).toBe(true);
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
