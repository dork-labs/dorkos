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
});
