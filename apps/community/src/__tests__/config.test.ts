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
});
