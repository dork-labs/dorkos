import { describe, expect, it } from 'vitest';
import {
  CLOUD_ORIGIN,
  CLOUD_ORIGIN_REFUSAL,
  chromeHostResolverRules,
  cloudOriginEntries,
  cookieReachesCloud,
  isCloudOriginUrl,
  playwrightBlockedOrigins,
  withoutCloudOrigin,
} from '../cloud-origin.js';
import { links } from '../links.js';

describe('the Cloud origin list', () => {
  it('is the production Cloud origin when nothing is configured', () => {
    expect(CLOUD_ORIGIN).toBe(links.cloudApi);
    expect(cloudOriginEntries()).toEqual([{ kind: 'host', host: 'cloud.dorkos.ai' }]);
  });

  it('adds the configured Cloud service, but never the default website', () => {
    expect(
      cloudOriginEntries({ DORKOS_CLOUD_URL: links.site, DORKOS_CLOUD_API_URL: undefined })
    ).toEqual([{ kind: 'host', host: 'cloud.dorkos.ai' }]);
    expect(
      cloudOriginEntries({
        DORKOS_CLOUD_URL: 'http://localhost:3000',
        DORKOS_CLOUD_API_URL: 'https://staging.cloud.example/',
      })
    ).toEqual([
      { kind: 'host', host: 'cloud.dorkos.ai' },
      { kind: 'host', host: 'staging.cloud.example' },
      { kind: 'origin', protocol: 'http:', host: 'localhost', port: '3000' },
    ]);
  });

  it('ignores a configured value that is not a web address', () => {
    expect(cloudOriginEntries({ DORKOS_CLOUD_API_URL: 'not a url' })).toHaveLength(1);
  });

  it('keeps the refusal short enough for app copy', () => {
    expect(CLOUD_ORIGIN_REFUSAL.split(/\s+/).length).toBeLessThanOrEqual(15);
  });
});

describe('isCloudOriginUrl', () => {
  it.each([
    'https://cloud.dorkos.ai',
    'https://cloud.dorkos.ai/',
    'https://cloud.dorkos.ai/any/path?x=1',
    'http://cloud.dorkos.ai:8080/',
    'https://CLOUD.dorkos.ai./',
    'https://app.cloud.dorkos.ai/',
    'https://a.b.cloud.dorkos.ai/',
  ])('matches %s', (url) => {
    expect(isCloudOriginUrl(url)).toBe(true);
  });

  it.each([
    'https://dorkos.ai/',
    'https://dorkos.ai/docs',
    'https://approve.dorkos.ai/',
    'https://evilcloud.dorkos.ai/',
    'https://cloud.dorkos.ai.example.com/',
    'https://example.com/?next=https://cloud.dorkos.ai/',
    'about:blank',
    'not a url',
  ])('leaves %s alone', (url) => {
    expect(isCloudOriginUrl(url)).toBe(false);
  });

  it('matches a local Cloud by its exact origin only', () => {
    const entries = cloudOriginEntries({ DORKOS_CLOUD_URL: 'http://localhost:3000' });
    expect(isCloudOriginUrl('http://localhost:3000/x', entries)).toBe(true);
    expect(isCloudOriginUrl('http://localhost:4242/', entries)).toBe(false);
    expect(isCloudOriginUrl('https://localhost:3000/', entries)).toBe(false);
  });
});

describe('cookieReachesCloud', () => {
  it.each(['cloud.dorkos.ai', '.cloud.dorkos.ai', 'app.cloud.dorkos.ai', '.dorkos.ai'])(
    'treats a cookie for %s as a Cloud cookie',
    (domain) => {
      expect(cookieReachesCloud(domain)).toBe(true);
    }
  );

  // A host-only `dorkos.ai` cookie is never sent to a subdomain, so it is not Cloud's.
  it.each(['dorkos.ai', 'github.com', '.github.com', 'evilcloud.dorkos.ai', ''])(
    'keeps a cookie for %s',
    (domain) => {
      expect(cookieReachesCloud(domain)).toBe(false);
    }
  );
});

describe('withoutCloudOrigin', () => {
  const cookie = (domain: string) => ({ name: 'session', value: 'secret', domain, path: '/' });

  it('drops Cloud cookies and page storage, keeps every other site', () => {
    const state = {
      cookies: [cookie('cloud.dorkos.ai'), cookie('.dorkos.ai'), cookie('github.com')],
      origins: [
        { origin: 'https://cloud.dorkos.ai', localStorage: [{ name: 'a', value: 'b' }] },
        { origin: 'https://github.com', localStorage: [{ name: 'c', value: 'd' }] },
      ],
    };
    const result = withoutCloudOrigin(state);
    expect(result.removedCookies).toBe(2);
    expect(result.removedOrigins).toBe(1);
    expect(result.state.cookies).toEqual([cookie('github.com')]);
    expect(result.state.origins).toEqual([state.origins[1]]);
  });
});

describe('the browser forms of the list', () => {
  it('blocks the Cloud host and its subdomains, on any port, in Playwright MCP', () => {
    expect(playwrightBlockedOrigins().split(';')).toEqual([
      'cloud.dorkos.ai',
      'http://cloud.dorkos.ai:*',
      'https://cloud.dorkos.ai:*',
      '*.cloud.dorkos.ai',
      'http://*.cloud.dorkos.ai:*',
      'https://*.cloud.dorkos.ai:*',
    ]);
  });

  it('makes the Cloud hosts unresolvable in Chrome, and never all of localhost', () => {
    expect(chromeHostResolverRules()).toBe(
      'MAP cloud.dorkos.ai ~NOTFOUND, MAP *.cloud.dorkos.ai ~NOTFOUND'
    );
    const local = cloudOriginEntries({ DORKOS_CLOUD_URL: 'http://localhost:3000' });
    expect(chromeHostResolverRules(local)).not.toContain('localhost');
    expect(playwrightBlockedOrigins(local)).toContain('http://localhost:3000');
  });
});
