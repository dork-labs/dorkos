/**
 * The mini app access page says "Spends money" for every paid app (DOR-4575),
 * read through the same normalized rule the spend limit enforces, so a
 * variant spelling of an app name never hides the marker. Made-up data only.
 */
import { describe, expect, it } from 'vitest';
import { PAID_BY_DEFAULT_TOOLKITS } from '@dorkos/shared/connector-schemas';
import { decidePage } from '../mini-app-access-page-assets.js';

/** The page for one waiting read of `service`. */
function pageFor(service: string, operations: string[]): string {
  return decidePage(
    {
      waiting: {
        extensionId: 'price-watch',
        extensionName: 'Price Watch',
        service,
        operations,
        reason: 'new',
      },
      filesDigest: 'sha256:files-1',
      accounts: [{ connectionId: 'acme-1', label: 'Acme' }],
    },
    'token-1'
  );
}

describe('the access page and paid apps', () => {
  it.each([...PAID_BY_DEFAULT_TOOLKITS])('marks %s as spending money', (toolkit) => {
    const html = pageFor(toolkit, [`${toolkit.toUpperCase()}_RUN`]);
    expect(html).toContain('data-testid="mini-app-spends-money"');
    expect(html).toContain('class="paid-marker"');
  });

  it.each(['Perplexity AI', 'perplexity_ai', 'APIFY', 'People-Data-Labs'])(
    'marks a variant spelling, %s, as spending money',
    (service) => {
      expect(pageFor(service, ['ANY_READ'])).toContain('data-testid="mini-app-spends-money"');
    }
  );

  it('marks only the paid read inside a free app', () => {
    const html = pageFor('github', ['GITHUB_LIST_ISSUES', 'GITHUB_RUN_INFERENCE']);
    expect(html).toContain('data-testid="mini-app-spends-money"');
    expect(html.match(/class="paid-marker"/g)).toHaveLength(1);
    expect(html).toMatch(/GITHUB_RUN_INFERENCE<\/code> <span class="paid-marker">/);
  });

  it('shows no marker for an app that costs nothing to read', () => {
    const html = pageFor('linear', ['LINEAR_LIST_LINEAR_PROJECTS']);
    expect(html).not.toContain('Spends money');
  });
});
