import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('bounds the import settings and keeps their defaults', () => {
    // Purpose: an import larger than 10,000 parts of one segment could never finish uploading,
    // so that setting is refused at startup rather than discovered by a stuck upload.
    const GIB = 1024 * 1024 * 1024;
    expect(parseConfig(valid).imports).toEqual({
      partConcurrency: 8,
      maxBytes: GIB,
      uploadHours: 24,
    });
    expect(
      parseConfig({ ...valid, COMMUNITY_IMPORT_MAX_BYTES: String(1024 * GIB) }).imports.maxBytes
    ).toBe(1024 * GIB);
    expect(() =>
      parseConfig({
        ...valid,
        COMMUNITY_IMPORT_MAX_BYTES: String(1024 * GIB),
        COMMUNITY_EXPORT_SEGMENT_BYTES: String(64 * 1024 * 1024),
      })
    ).toThrow('10,000 times');
    expect(() => parseConfig({ ...valid, COMMUNITY_IMPORT_PART_CONCURRENCY: '65' })).toThrow();
    expect(() => parseConfig({ ...valid, COMMUNITY_IMPORT_UPLOAD_HOURS: '169' })).toThrow();
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

  it('asks no minimum age unless the host sets a whole number from 13 to 21', () => {
    // Purpose: fails if an unset or blank setting turns the age check on, or a typo such as 180,
    // a fraction or a word starts a Community with an age check nobody meant.
    expect(parseConfig(valid).minimumAge).toBeNull();
    expect(parseConfig({ ...valid, COMMUNITY_MINIMUM_AGE: '' }).minimumAge).toBeNull();
    expect(parseConfig({ ...valid, COMMUNITY_MINIMUM_AGE: '18' }).minimumAge).toBe(18);
    expect(parseConfig({ ...valid, COMMUNITY_MINIMUM_AGE: '13' }).minimumAge).toBe(13);
    expect(parseConfig({ ...valid, COMMUNITY_MINIMUM_AGE: '21' }).minimumAge).toBe(21);
    for (const value of ['12', '22', '180', '16.5', 'eighteen', '-18'])
      expect(() => parseConfig({ ...valid, COMMUNITY_MINIMUM_AGE: value }), value).toThrow(
        'COMMUNITY_MINIMUM_AGE'
      );
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

  it('has no evidence store unless the host names a driver, and refuses stray evidence settings', () => {
    // Purpose: fails if a half-configured evidence store is silently ignored.
    expect(parseConfig(valid).evidence).toBeNull();
    expect(parseConfig({ ...valid, COMMUNITY_EVIDENCE_DRIVER: '' }).evidence).toBeNull();
    expect(() => parseConfig({ ...valid, COMMUNITY_EVIDENCE_PATH: '/srv/evidence' })).toThrow(
      'COMMUNITY_EVIDENCE_PATH is set, but COMMUNITY_EVIDENCE_DRIVER is not'
    );
    expect(
      parseConfig({
        ...valid,
        COMMUNITY_EVIDENCE_DRIVER: 'filesystem',
        COMMUNITY_EVIDENCE_PATH: '/srv/evidence',
      }).evidence
    ).toEqual({ kind: 'filesystem', directory: '/srv/evidence' });
    expect(parseConfig(valid).limits.takedownEvidenceAlertHours).toBe(6);
    expect(() => parseConfig({ ...valid, COMMUNITY_TAKEDOWN_EVIDENCE_ALERT_HOURS: '0' })).toThrow();
    expect(() =>
      parseConfig({ ...valid, COMMUNITY_TAKEDOWN_EVIDENCE_ALERT_HOURS: '169' })
    ).toThrow();
  });

  it('keeps a community takedown reversible for at least a day and limits takedowns per day', () => {
    // Purpose (AC-13): fails if a host could set a reversal window under a day (a takedown that
    // cannot be undone) or over thirty days, or turn the per-actor daily limit off.
    expect(parseConfig(valid).limits.takedownReversalHours).toBe(72);
    expect(parseConfig(valid).limits.takedownCommunitiesPerDay).toBe(3);
    for (const hours of ['24', '720'])
      expect(
        parseConfig({ ...valid, COMMUNITY_TAKEDOWN_REVERSAL_HOURS: hours }).limits
          .takedownReversalHours
      ).toBe(Number(hours));
    for (const hours of ['23', '721', '0'])
      expect(() => parseConfig({ ...valid, COMMUNITY_TAKEDOWN_REVERSAL_HOURS: hours })).toThrow(
        /COMMUNITY_TAKEDOWN_REVERSAL_HOURS/
      );
    for (const count of ['0', '101'])
      expect(() =>
        parseConfig({ ...valid, COMMUNITY_TAKEDOWN_COMMUNITIES_PER_DAY: count })
      ).toThrow(/COMMUNITY_TAKEDOWN_COMMUNITIES_PER_DAY/);
    expect(
      parseConfig({ ...valid, COMMUNITY_TAKEDOWN_COMMUNITIES_PER_DAY: '100' }).limits
        .takedownCommunitiesPerDay
    ).toBe(100);
  });

  it('keeps a filesystem evidence store apart from everything the server serves, stores, or stages', async () => {
    // Purpose (AC-14): fails if evidence could land where it is served, swept, or staged: the
    // primary store, the web app folder, or the temporary folder, whether equal, containing, or
    // inside, and even through a symbolic link.
    const evidence =
      (path: string, storage = '/srv/data/blobs') =>
      () =>
        parseConfig({
          ...valid,
          COMMUNITY_STORAGE_PATH: storage,
          COMMUNITY_EVIDENCE_DRIVER: 'filesystem',
          COMMUNITY_EVIDENCE_PATH: path,
        });
    expect(evidence('evidence')).toThrow('COMMUNITY_EVIDENCE_PATH must be an absolute path');
    for (const path of ['/srv/data/blobs', '/srv/data/blobs/evidence', '/srv/data', '/'])
      expect(evidence(path), path).toThrow('COMMUNITY_STORAGE_PATH');
    const served = fileURLToPath(new URL('../../dist/', import.meta.url));
    for (const path of [served, join(served, 'evidence'), join(served, '..')])
      expect(evidence(path), path).toThrow('the web app folder');
    expect(evidence(join(tmpdir(), 'evidence'))).toThrow('the temporary folder');
    expect(evidence('/srv/evidence')).not.toThrow();
    // A link that points into the temporary folder is still inside it.
    const outside = await mkdtemp(join(fileURLToPath(new URL('../../', import.meta.url)), '.cfg-'));
    try {
      await symlink(tmpdir(), join(outside, 'link'));
      expect(evidence(join(outside, 'link', 'evidence'))).toThrow('the temporary folder');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('requires a separate bucket, or another endpoint, for an S3 evidence store', () => {
    // Purpose (AC-14): fails if evidence could be written into the primary bucket.
    const s3 = {
      ...valid,
      COMMUNITY_STORAGE_DRIVER: 's3',
      COMMUNITY_S3_BUCKET: 'primary',
      COMMUNITY_S3_REGION: 'auto',
      COMMUNITY_S3_ENDPOINT: 'https://s3.example.com',
      COMMUNITY_EVIDENCE_DRIVER: 's3',
      COMMUNITY_EVIDENCE_S3_REGION: 'auto',
    };
    expect(() =>
      parseConfig({
        ...s3,
        COMMUNITY_EVIDENCE_S3_BUCKET: 'primary',
        COMMUNITY_EVIDENCE_S3_ENDPOINT: 'https://s3.example.com',
      })
    ).toThrow('different bucket');
    expect(
      parseConfig({
        ...s3,
        COMMUNITY_EVIDENCE_S3_BUCKET: 'primary',
        COMMUNITY_EVIDENCE_S3_ENDPOINT: 'https://evidence.example.com',
      }).evidence
    ).toMatchObject({ kind: 's3', bucket: 'primary', endpoint: 'https://evidence.example.com' });
    expect(
      parseConfig({
        ...s3,
        COMMUNITY_EVIDENCE_S3_BUCKET: 'evidence',
        COMMUNITY_EVIDENCE_S3_ENDPOINT: 'https://s3.example.com',
        COMMUNITY_EVIDENCE_S3_PREFIX: 'host-a/takedowns',
      }).evidence
    ).toMatchObject({ bucket: 'evidence', prefix: 'host-a/takedowns' });
    expect(() => parseConfig({ ...s3, COMMUNITY_EVIDENCE_S3_BUCKET: undefined })).toThrow(
      'COMMUNITY_EVIDENCE_S3_BUCKET'
    );
    for (const prefix of ['/abs', 'a//b', 'a/../b', '..', 'a/./b', 'has space'])
      expect(
        () =>
          parseConfig({
            ...s3,
            COMMUNITY_EVIDENCE_S3_BUCKET: 'evidence',
            COMMUNITY_EVIDENCE_S3_PREFIX: prefix,
          }),
        prefix
      ).toThrow('COMMUNITY_EVIDENCE_S3_PREFIX');
    expect(() =>
      parseConfig({
        ...s3,
        COMMUNITY_EVIDENCE_S3_BUCKET: 'evidence',
        COMMUNITY_EVIDENCE_S3_ENDPOINT: 'http://evidence.example.com',
      })
    ).toThrow('COMMUNITY_EVIDENCE_S3_ENDPOINT must use HTTPS');
  });

  it('sends no mail unless the host sets both mail settings, and keeps the replacement defaults', () => {
    // Purpose: fails if mail turns on by default, or if the owner-replacement waits drift from
    // 14, 30 and 90 days when nothing is set.
    const config = parseConfig(valid);
    expect(config.mail).toBeNull();
    expect(config.ownerReplacement).toEqual({
      noticeDays: 14,
      unreachableDays: 30,
      objectionCooldownDays: 90,
    });
    // Compose passes an unset setting through as an empty string.
    expect(parseConfig({ ...valid, COMMUNITY_SMTP_URL: '', COMMUNITY_MAIL_FROM: '' }).mail).toBe(
      null
    );
  });

  it('reads an encrypted SMTP server, its credentials, and one sender mailbox', () => {
    // Purpose: fails if implicit TLS, required STARTTLS, default ports, percent-encoded
    // credentials, or a named sender are read wrongly, or if loopback loses its plain-text carve-out.
    const from = 'Example Community <notices@example.com>';
    expect(
      parseConfig({
        ...valid,
        COMMUNITY_SMTP_URL: 'smtps://mailer:p%40ss%2Fword@smtp.example.com',
        COMMUNITY_MAIL_FROM: from,
      }).mail
    ).toEqual({
      smtp: {
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        requireTLS: false,
        auth: { user: 'mailer', pass: 'p@ss/word' },
      },
      from: { name: 'Example Community', address: 'notices@example.com' },
    });
    expect(
      parseConfig({
        ...valid,
        COMMUNITY_SMTP_URL: 'smtp://smtp.example.com?starttls=required',
        COMMUNITY_MAIL_FROM: 'notices@example.com',
      }).mail
    ).toEqual({
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        requireTLS: true,
        auth: null,
      },
      from: { name: null, address: 'notices@example.com' },
    });
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const mail = parseConfig({
        ...valid,
        COMMUNITY_SMTP_URL: `smtp://${host}:2525`,
        COMMUNITY_MAIL_FROM: '"Relay, Local" <notices@example.com>',
      }).mail;
      expect(mail?.smtp).toMatchObject({ port: 2525, secure: false, requireTLS: false });
      expect(mail?.from).toEqual({ name: 'Relay, Local', address: 'notices@example.com' });
    }
  });

  it('treats localhost as 127.0.0.1 for a plain relay, and refuses port 0', () => {
    // Purpose: fails if the no-encryption exemption trusts a name lookup for localhost, is fooled
    // by upper case, or accepts port 0; an encrypted connection keeps its name for certificates.
    const env = { ...valid, COMMUNITY_MAIL_FROM: 'notices@example.com' };
    for (const url of ['smtp://localhost', 'smtp://LocalHost:2525'])
      expect(parseConfig({ ...env, COMMUNITY_SMTP_URL: url }).mail?.smtp.host, url).toBe(
        '127.0.0.1'
      );
    expect(parseConfig({ ...env, COMMUNITY_SMTP_URL: 'smtps://LOCALHOST' }).mail?.smtp.host).toBe(
      'localhost'
    );
    expect(parseConfig({ ...env, COMMUNITY_SMTP_URL: 'smtp://[::1]' }).mail?.smtp.host).toBe('::1');
    for (const url of ['smtps://smtp.example.com:0', 'smtp://127.0.0.1:0'])
      expect(() => parseConfig({ ...env, COMMUNITY_SMTP_URL: url }), url).toThrow('port 0');
  });

  it('refuses mail settings that are half set, unencrypted off loopback, or not one mailbox', () => {
    // Purpose (AC-5): fails if one mail setting alone, plain SMTP to another machine, a stray
    // option, a path, half a credential, or a sender that could add a header or a second
    // address starts the server.
    const smtp = 'smtps://smtp.example.com';
    const from = 'notices@example.com';
    for (const env of [
      { COMMUNITY_SMTP_URL: smtp },
      { COMMUNITY_MAIL_FROM: from },
      { COMMUNITY_SMTP_URL: 'smtp://smtp.example.com', COMMUNITY_MAIL_FROM: from },
      { COMMUNITY_SMTP_URL: 'smtp://smtp.example.com:25', COMMUNITY_MAIL_FROM: from },
      { COMMUNITY_SMTP_URL: 'smtp://10.0.0.5', COMMUNITY_MAIL_FROM: from },
      {
        COMMUNITY_SMTP_URL: 'smtp://smtp.example.com?starttls=optional',
        COMMUNITY_MAIL_FROM: from,
      },
      {
        COMMUNITY_SMTP_URL: 'smtps://smtp.example.com?starttls=required',
        COMMUNITY_MAIL_FROM: from,
      },
      { COMMUNITY_SMTP_URL: 'smtps://smtp.example.com?pool=true', COMMUNITY_MAIL_FROM: from },
      { COMMUNITY_SMTP_URL: 'smtps://smtp.example.com/relay', COMMUNITY_MAIL_FROM: from },
      { COMMUNITY_SMTP_URL: 'smtps://mailer@smtp.example.com', COMMUNITY_MAIL_FROM: from },
      { COMMUNITY_SMTP_URL: 'https://smtp.example.com', COMMUNITY_MAIL_FROM: from },
      { COMMUNITY_SMTP_URL: 'not a url', COMMUNITY_MAIL_FROM: from },
      { COMMUNITY_SMTP_URL: smtp, COMMUNITY_MAIL_FROM: 'not an address' },
      { COMMUNITY_SMTP_URL: smtp, COMMUNITY_MAIL_FROM: 'a@example.com, b@example.com' },
      { COMMUNITY_SMTP_URL: smtp, COMMUNITY_MAIL_FROM: 'notices@example.com\r\nBcc: x@evil.test' },
      { COMMUNITY_SMTP_URL: smtp, COMMUNITY_MAIL_FROM: 'Team: a@example.com;' },
      { COMMUNITY_SMTP_URL: smtp, COMMUNITY_MAIL_FROM: 'Name <a@example.com> <b@example.com>' },
    ])
      expect(() => parseConfig({ ...valid, ...env }), JSON.stringify(env)).toThrow(
        /COMMUNITY_(SMTP_URL|MAIL_FROM)/u
      );
  });

  it('never echoes the SMTP address or its password in a configuration error', () => {
    // Purpose: fails if a refused mail setting prints its credentials, directly or through an
    // error cause, where a startup crash would log them.
    for (const url of [
      'smtp://mailer:hunter2-secret@smtp.example.com',
      'smtps://mailer:hunter2-secret@smtp.example.com/path',
      'smtps://mailer:hunter2-secret@smtp.example.com?x=1',
      'smtps://mailer:hunter2-secret@[bad',
    ]) {
      let caught: unknown;
      try {
        parseConfig({ ...valid, COMMUNITY_SMTP_URL: url, COMMUNITY_MAIL_FROM: 'n@example.com' });
      } catch (error) {
        caught = error;
      }
      expect(caught, url).toBeInstanceOf(Error);
      const error = caught as Error;
      expect(error.cause, url).toBeUndefined();
      expect(error.message, url).not.toContain('hunter2');
      expect(error.message, url).not.toContain('smtp.example.com');
    }
  });

  it('bounds the owner-replacement waits and keeps the long wait at least the short one', () => {
    // Purpose (AC-5): fails if a notice wait under a week, a long wait under two weeks or below
    // the notice wait, or a cooling-off under 30 days starts the server.
    const bounds = parseConfig({
      ...valid,
      COMMUNITY_OWNER_REPLACEMENT_NOTICE_DAYS: '90',
      COMMUNITY_OWNER_REPLACEMENT_UNREACHABLE_DAYS: '180',
      COMMUNITY_OWNER_REPLACEMENT_OBJECTION_COOLDOWN_DAYS: '365',
    }).ownerReplacement;
    expect(bounds).toEqual({ noticeDays: 90, unreachableDays: 180, objectionCooldownDays: 365 });
    expect(
      parseConfig({
        ...valid,
        COMMUNITY_OWNER_REPLACEMENT_NOTICE_DAYS: '7',
        COMMUNITY_OWNER_REPLACEMENT_UNREACHABLE_DAYS: '14',
        COMMUNITY_OWNER_REPLACEMENT_OBJECTION_COOLDOWN_DAYS: '30',
      }).ownerReplacement
    ).toEqual({ noticeDays: 7, unreachableDays: 14, objectionCooldownDays: 30 });
    for (const env of [
      { COMMUNITY_OWNER_REPLACEMENT_NOTICE_DAYS: '6' },
      { COMMUNITY_OWNER_REPLACEMENT_NOTICE_DAYS: '91' },
      { COMMUNITY_OWNER_REPLACEMENT_UNREACHABLE_DAYS: '13' },
      { COMMUNITY_OWNER_REPLACEMENT_UNREACHABLE_DAYS: '181' },
      {
        COMMUNITY_OWNER_REPLACEMENT_NOTICE_DAYS: '40',
        COMMUNITY_OWNER_REPLACEMENT_UNREACHABLE_DAYS: '39',
      },
      { COMMUNITY_OWNER_REPLACEMENT_NOTICE_DAYS: '31' },
      { COMMUNITY_OWNER_REPLACEMENT_OBJECTION_COOLDOWN_DAYS: '29' },
      { COMMUNITY_OWNER_REPLACEMENT_OBJECTION_COOLDOWN_DAYS: '366' },
    ])
      expect(() => parseConfig({ ...valid, ...env }), JSON.stringify(env)).toThrow(
        /COMMUNITY_OWNER_REPLACEMENT/u
      );
  });
});
