import { describe, expect, it } from 'vitest';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import { serviceLogo } from '../lib/service-logo';

const base: ConnectorCatalogService = {
  serviceSlug: 'zendesk',
  displayName: 'Zendesk',
  iconKey: 'zendesk',
  intents: [{ kind: 'account', displayName: 'Use a Zendesk account', routes: [] }],
};

describe('serviceLogo', () => {
  it('keeps "listed without a logo" apart from "not listed"', () => {
    expect(serviceLogo({ ...base, logo: '/api/connectors/catalog/logos/zendesk' })).toBe(
      '/api/connectors/catalog/logos/zendesk'
    );
    expect(serviceLogo(base)).toBeNull();
    expect(serviceLogo(null)).toBeUndefined();
    expect(serviceLogo(undefined)).toBeUndefined();
  });
});
