import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseConfig } from '../config.js';
import { createBlobStore, FileSystemBlobStore, S3BlobStore } from '../storage/index.js';

const valid = {
  COMMUNITY_DATABASE_URL: 'postgres://postgres:pass@localhost:5432/community',
  COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
  COMMUNITY_STORAGE_PATH: '/tmp/community-blobs',
};

describe('community startup config', () => {
  it('keeps bulk tenant reconciliation out of ordinary startup', async () => {
    const startup = await readFile(new URL('../main.ts', import.meta.url), 'utf8');

    expect(startup).not.toContain('reconcileTenantNamespace');
  });

  it('requires every deployment secret and storage setting', () => {
    expect(() => parseConfig({})).toThrow('COMMUNITY_DATABASE_URL');
    expect(() => parseConfig({ ...valid, COMMUNITY_BOOTSTRAP_SECRET: undefined })).toThrow(
      'COMMUNITY_BOOTSTRAP_SECRET'
    );
  });

  it('enforces positive quotas and hard ceilings', () => {
    expect(parseConfig(valid).limits.postsPerTenMinutes).toBe(120);
    expect(() => parseConfig({ ...valid, COMMUNITY_POSTS_PER_TEN_MINUTES: '1001' })).toThrow();
    expect(() => parseConfig({ ...valid, COMMUNITY_TEXT_BYTES: '0' })).toThrow();
  });

  it('bounds the export settings and keeps their defaults', () => {
    // Purpose: a segment below 64 MiB or above the 1 GiB blob ceiling, an archive that outlives a
    // week, or more than 8 jobs a replica must be refused at startup, not discovered mid-export.
    expect(parseConfig(valid).exports).toEqual({
      segmentBytes: 256 * 1024 * 1024,
      ttlHours: 24,
      maxHours: 24,
      concurrency: 1,
    });
    const mib = 1024 * 1024;
    expect(
      parseConfig({ ...valid, COMMUNITY_EXPORT_SEGMENT_BYTES: String(64 * mib) }).exports
        .segmentBytes
    ).toBe(64 * mib);
    for (const [name, value] of [
      ['COMMUNITY_EXPORT_SEGMENT_BYTES', String(64 * mib - 1)],
      ['COMMUNITY_EXPORT_SEGMENT_BYTES', String(1024 * mib + 1)],
      ['COMMUNITY_EXPORT_TTL_HOURS', '0'],
      ['COMMUNITY_EXPORT_TTL_HOURS', '169'],
      ['COMMUNITY_EXPORT_MAX_HOURS', '169'],
      ['COMMUNITY_EXPORT_CONCURRENCY', '9'],
      ['COMMUNITY_EXPORT_CONCURRENCY', '0'],
    ] as const) {
      expect(() => parseConfig({ ...valid, [name]: value }), `${name}=${value}`).toThrow();
    }
  });

  it('keeps the agents-per-person default at 20 with a maximum of 100', () => {
    // Purpose: a per-member override may go higher (to 1,000); the host-wide setting may not.
    expect(parseConfig(valid).limits.agentsPerOwner).toBe(20);
    expect(parseConfig({ ...valid, COMMUNITY_AGENTS_PER_OWNER: '100' }).limits.agentsPerOwner).toBe(
      100
    );
    expect(() => parseConfig({ ...valid, COMMUNITY_AGENTS_PER_OWNER: '101' })).toThrow();
  });

  it('adds a host’s own reserved short names to the built-in list, in the same grammar', () => {
    // Purpose: fails if a host addition is dropped, or a malformed one is accepted silently.
    const config = parseConfig({ ...valid, COMMUNITY_RESERVED_SHORT_NAMES: ' Brand, our-team ' });
    expect(config.reservedShortNames.has('brand')).toBe(true);
    expect(config.reservedShortNames.has('our-team')).toBe(true);
    expect(config.reservedShortNames.has('admin')).toBe(true);
    expect(() => parseConfig({ ...valid, COMMUNITY_RESERVED_SHORT_NAMES: 'ok-name,x!' })).toThrow();
    expect(parseConfig(valid).limits.shortNameCooloffDays).toBe(90);
    expect(
      parseConfig({ ...valid, COMMUNITY_SHORT_NAME_COOLOFF_DAYS: '0' }).limits.shortNameCooloffDays
    ).toBe(0);
    expect(() => parseConfig({ ...valid, COMMUNITY_SHORT_NAME_COOLOFF_DAYS: '366' })).toThrow();
    expect(parseConfig(valid).limits.nameLookupsPerMinute).toBe(60);
    expect(() => parseConfig({ ...valid, COMMUNITY_NAME_LOOKUPS_PER_MINUTE: '601' })).toThrow();
  });

  it('trusts no proxy header unless one is named, and only a well-formed header name', () => {
    // Purpose: fails if a proxy header is trusted by default (callers could choose their own
    // limit bucket), or a malformed name is accepted silently.
    expect(parseConfig(valid).trustedProxyHeader).toBeUndefined();
    expect(parseConfig({ ...valid, COMMUNITY_TRUSTED_PROXY_HEADER: '' }).trustedProxyHeader).toBe(
      undefined
    );
    expect(
      parseConfig({ ...valid, COMMUNITY_TRUSTED_PROXY_HEADER: ' Fly-Client-IP ' })
        .trustedProxyHeader
    ).toBe('fly-client-ip');
    expect(() =>
      parseConfig({ ...valid, COMMUNITY_TRUSTED_PROXY_HEADER: 'X-Real-IP: 1.2.3.4' })
    ).toThrow('COMMUNITY_TRUSTED_PROXY_HEADER');
  });

  it('requires at least a week of notice before a host may delete a held community', () => {
    // Purpose: fails if a host could configure a notice too short for an owner to export.
    expect(parseConfig(valid).limits.hostDeletionNoticeDays).toBe(14);
    expect(() => parseConfig({ ...valid, COMMUNITY_HOST_DELETION_NOTICE_DAYS: '6' })).toThrow();
    expect(() => parseConfig({ ...valid, COMMUNITY_HOST_DELETION_NOTICE_DAYS: '366' })).toThrow();
    expect(
      parseConfig({ ...valid, COMMUNITY_HOST_DELETION_NOTICE_DAYS: '7' }).limits
        .hostDeletionNoticeDays
    ).toBe(7);
  });

  it('selects filesystem storage and validates its persistent path', () => {
    expect(parseConfig(valid).storage).toEqual({
      kind: 'filesystem',
      directory: '/tmp/community-blobs',
    });
    expect(createBlobStore(parseConfig(valid))).toBeInstanceOf(FileSystemBlobStore);
    expect(() => parseConfig({ ...valid, COMMUNITY_STORAGE_PATH: 'relative/blobs' })).toThrow();
  });

  it('accepts complete S3-compatible settings without requiring a filesystem path', () => {
    const s3 = {
      ...valid,
      COMMUNITY_STORAGE_PATH: undefined,
      COMMUNITY_STORAGE_DRIVER: 's3',
      COMMUNITY_S3_BUCKET: 'community-blobs',
      COMMUNITY_S3_REGION: 'us-east-1',
      COMMUNITY_S3_ENDPOINT: 'http://127.0.0.1:4602',
      COMMUNITY_S3_ACCESS_KEY_ID: 'test',
      COMMUNITY_S3_SECRET_ACCESS_KEY: 'test-secret',
    };
    expect(parseConfig(s3).storage).toMatchObject({ kind: 's3', bucket: 'community-blobs' });
    expect(createBlobStore(parseConfig(s3))).toBeInstanceOf(S3BlobStore);
    expect(() => parseConfig({ ...s3, COMMUNITY_S3_BUCKET: undefined })).toThrow();
    expect(() => parseConfig({ ...s3, COMMUNITY_S3_SECRET_ACCESS_KEY: undefined })).toThrow();
    expect(() =>
      parseConfig({ ...s3, COMMUNITY_S3_ENDPOINT: 'http://storage.example.com' })
    ).toThrow();
    expect(() => parseConfig({ ...s3, COMMUNITY_S3_ENDPOINT: 'ftp://localhost:4602' })).toThrow();
    expect(() =>
      parseConfig({ ...s3, COMMUNITY_S3_ENDPOINT: 'http://user:pass@localhost:4602' })
    ).toThrow();
    expect(
      parseConfig({ ...s3, COMMUNITY_S3_ENDPOINT: 'http://localhost:4602/prefix' }).storage
    ).toMatchObject({ kind: 's3' });
  });

  it('accepts only a bare HTTPS origin or HTTP loopback origin for the public URL', () => {
    expect(parseConfig(valid).publicUrl).toBe('http://localhost:6481');
    expect(
      parseConfig({ ...valid, COMMUNITY_PUBLIC_URL: 'https://community.example.com/' }).publicUrl
    ).toBe('https://community.example.com');
    for (const url of [
      'ftp://localhost:6481',
      'http://community.example.com',
      'http://user:pass@localhost:6481',
      'https://community.example.com/join',
      'https://community.example.com/?mode=join',
      'https://community.example.com/#invite',
    ])
      expect(() => parseConfig({ ...valid, COMMUNITY_PUBLIC_URL: url })).toThrow();
  });

  it('accepts empty optional rotation settings from Compose but requires a complete previous key', () => {
    expect(
      parseConfig({
        ...valid,
        COMMUNITY_INVITE_PREVIOUS_KEY_ID: '',
        COMMUNITY_INVITE_PREVIOUS_SECRET: '',
      }).invitePreviousKeyId
    ).toBeUndefined();
    expect(() =>
      parseConfig({
        ...valid,
        COMMUNITY_INVITE_PREVIOUS_KEY_ID: 'v0',
        COMMUNITY_INVITE_PREVIOUS_SECRET: '',
      })
    ).toThrow();
  });

  it('shows no host links unless the host sets them, and treats Compose blanks as unset', () => {
    // Purpose: a self-hosted Community must render no Terms, Privacy or Report control at all.
    const unset = { termsUrl: null, privacyUrl: null, reportAbuseUrl: null };
    expect(parseConfig(valid).hostLinks).toEqual(unset);
    expect(
      parseConfig({
        ...valid,
        COMMUNITY_TERMS_URL: '',
        COMMUNITY_PRIVACY_URL: '',
        COMMUNITY_REPORT_ABUSE_URL: '',
      }).hostLinks
    ).toEqual(unset);
    expect(
      parseConfig({
        ...valid,
        COMMUNITY_TERMS_URL: 'https://example.com/terms',
        COMMUNITY_PRIVACY_URL: 'https://example.com/privacy',
        COMMUNITY_REPORT_ABUSE_URL: 'mailto:abuse@example.com',
      }).hostLinks
    ).toEqual({
      termsUrl: 'https://example.com/terms',
      privacyUrl: 'https://example.com/privacy',
      reportAbuseUrl: 'mailto:abuse@example.com',
    });
  });

  it('refuses a host link that is not HTTPS, or for reports a bare mailto address', () => {
    // Purpose: fails if a link can be plain HTTP, script, carry credentials, or smuggle a
    // pre-filled mail body past the one the Report link writes itself.
    const refuse = (name: string, value: string) =>
      expect(() => parseConfig({ ...valid, [name]: value }), `${name}=${value}`).toThrow(name);
    refuse('COMMUNITY_TERMS_URL', 'http://example.com');
    refuse('COMMUNITY_TERMS_URL', 'example.com/terms');
    refuse('COMMUNITY_TERMS_URL', 'mailto:legal@example.com');
    refuse('COMMUNITY_PRIVACY_URL', 'javascript:alert(1)');
    refuse('COMMUNITY_PRIVACY_URL', 'https://user:pass@example.com/privacy');
    refuse('COMMUNITY_REPORT_ABUSE_URL', 'http://example.com/report');
    refuse('COMMUNITY_REPORT_ABUSE_URL', 'mailto:abuse@example.com?body=hello');
    refuse('COMMUNITY_REPORT_ABUSE_URL', 'mailto:not-an-address');
    refuse('COMMUNITY_REPORT_ABUSE_URL', 'data:text/html,hi');
  });

  it('accepts only one bare mailbox as a mailto report address, even once decoded', () => {
    // Purpose: fails if a report address can swallow the body the Report link writes (a trailing
    // `?` or `#`), or add a second recipient or a header, plainly or percent-encoded.
    for (const value of [
      'mailto:abuse@example.com?',
      'mailto:abuse@example.com#',
      'mailto:a,b@evil.com',
      'mailto:a;b@x.com',
      'mailto:abuse%0ABcc:x@evil.com',
      'mailto:%0D%0Aabuse@x.com',
      'mailto:abuse@example.com%3Fcc%3Dx',
      'mailto:abuse@x.com&cc=e',
      'mailto:abuse@example.com%20',
      'mailto:abuse@example.com%',
      'mailto:abuse@example',
    ])
      expect(() => parseConfig({ ...valid, COMMUNITY_REPORT_ABUSE_URL: value }), value).toThrow(
        'COMMUNITY_REPORT_ABUSE_URL'
      );
    expect(
      parseConfig({ ...valid, COMMUNITY_REPORT_ABUSE_URL: 'mailto:report+abuse@mail.example.com' })
        .hostLinks.reportAbuseUrl
    ).toBe('mailto:report+abuse@mail.example.com');
    expect(
      parseConfig({ ...valid, COMMUNITY_REPORT_ABUSE_URL: 'https://example.com/report?form=1' })
        .hostLinks.reportAbuseUrl
    ).toBe('https://example.com/report?form=1');
  });

  it('reads OpenID Connect settings all or none, with a default label and scopes', () => {
    // Purpose: fails if a partial issuer pair starts half-configured, or the defaults drift.
    expect(parseConfig(valid).oidc).toBeNull();
    const oidc = {
      COMMUNITY_OIDC_ISSUER_URL: 'https://id.example.com/realms/team/',
      COMMUNITY_OIDC_CLIENT_ID: 'community',
      COMMUNITY_OIDC_CLIENT_SECRET: 'secret',
    };
    expect(parseConfig({ ...valid, ...oidc }).oidc).toEqual({
      issuer: 'https://id.example.com/realms/team',
      clientId: 'community',
      clientSecret: 'secret',
      label: 'Single sign-on',
      scopes: ['openid', 'email', 'profile'],
    });
    expect(
      parseConfig({
        ...valid,
        ...oidc,
        COMMUNITY_OIDC_LABEL: '  Example Workspace  ',
        COMMUNITY_OIDC_SCOPES: 'openid email',
      }).oidc
    ).toMatchObject({ label: 'Example Workspace', scopes: ['openid', 'email'] });
    // Compose passes unset variables as empty strings.
    expect(
      parseConfig({
        ...valid,
        COMMUNITY_OIDC_ISSUER_URL: '',
        COMMUNITY_OIDC_CLIENT_ID: '',
        COMMUNITY_OIDC_CLIENT_SECRET: '',
        COMMUNITY_OIDC_LABEL: '',
        COMMUNITY_OIDC_SCOPES: '',
      }).oidc
    ).toBeNull();
    expect(
      parseConfig({ ...valid, ...oidc, COMMUNITY_OIDC_ISSUER_URL: 'http://localhost:9000' }).oidc
        ?.issuer
    ).toBe('http://localhost:9000');
  });

  it('refuses an incomplete, non-HTTPS or malformed OpenID Connect setting', () => {
    // Purpose: fails if the issuer can be plain HTTP off loopback, carry credentials, or if a
    // missing piece, a label outside 1 to 40 characters, or scopes without openid pass.
    const oidc = {
      COMMUNITY_OIDC_ISSUER_URL: 'https://id.example.com',
      COMMUNITY_OIDC_CLIENT_ID: 'community',
      COMMUNITY_OIDC_CLIENT_SECRET: 'secret',
    };
    for (const env of [
      { COMMUNITY_OIDC_ISSUER_URL: oidc.COMMUNITY_OIDC_ISSUER_URL },
      { ...oidc, COMMUNITY_OIDC_CLIENT_SECRET: undefined },
      { COMMUNITY_OIDC_LABEL: 'Orphan label' },
      { ...oidc, COMMUNITY_OIDC_ISSUER_URL: 'http://id.example.com' },
      { ...oidc, COMMUNITY_OIDC_ISSUER_URL: 'https://user:pass@id.example.com' },
      { ...oidc, COMMUNITY_OIDC_ISSUER_URL: 'https://id.example.com/?tenant=1' },
      { ...oidc, COMMUNITY_OIDC_ISSUER_URL: 'not a url' },
      { ...oidc, COMMUNITY_OIDC_LABEL: 'x'.repeat(41) },
      { ...oidc, COMMUNITY_OIDC_LABEL: '   ' },
      { ...oidc, COMMUNITY_OIDC_SCOPES: 'email profile' },
      { ...oidc, COMMUNITY_OIDC_SCOPES: 'openid "email"' },
    ])
      expect(() => parseConfig({ ...valid, ...env }), JSON.stringify(env)).toThrow(
        /COMMUNITY_OIDC/u
      );
  });
});
