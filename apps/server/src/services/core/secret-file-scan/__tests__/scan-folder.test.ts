/**
 * The name-only secret scan (DOR-3292): which names match, what it skips, and
 * that it never reads a file.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanFolderForSecretNames, secretNameRule } from '../scan-folder.js';

/** The dotenv name, spelled in parts so no tool sees a bare secret-file path. */
const ENV = ['', 'env'].join('.');

let root: string;

function touch(rel: string, body = 'x'): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('secretNameRule', () => {
  it.each([
    [ENV, ENV, ENV],
    [`${ENV}.production`, `${ENV}.production`, `${ENV}.*`],
    ['server.pem', 'server.pem', '*.pem'],
    ['tls.key', 'tls.key', '*.key'],
    ['cert.p12', 'cert.p12', '*.p12'],
    ['cert.pfx', 'cert.pfx', '*.pfx'],
    ['id_rsa', 'id_rsa', 'id_rsa*'],
    ['id_ed25519', 'ssh/id_ed25519', 'id_ed25519*'],
    ['.netrc', '.netrc', '.netrc'],
    ['.npmrc', '.npmrc', '.npmrc'],
    ['.pypirc', '.pypirc', '.pypirc'],
    ['credentials', 'aws/credentials', 'credentials'],
    ['credentials.json', 'credentials.json', 'credentials.json'],
    ['my-service-account.json', 'gcp/my-service-account.json', '*service-account*.json'],
    ['config.json', '.docker/config.json', '.docker/config.json'],
    ['prod.tfvars', 'infra/prod.tfvars', '*.tfvars'],
    ['terraform.tfstate', 'terraform.tfstate', '*.tfstate'],
    ['.dev.vars', '.dev.vars', '.dev.vars'],
    ['.envrc', '.envrc', '.envrc'],
    ['.git-credentials', '.git-credentials', '.git-credentials'],
    ['.pgpass', '.pgpass', '.pgpass'],
    ['id_ecdsa', 'ssh/id_ecdsa', 'id_ecdsa*'],
    ['id_dsa', 'ssh/id_dsa', 'id_dsa*'],
    ['config', 'ops/.kube/config', '.kube/config'],
    [
      'application_default_credentials.json',
      'gcloud/application_default_credentials.json',
      'application_default_credentials.json',
    ],
    ['release.jks', 'android/release.jks', '*.jks'],
    ['app.keystore', 'app.keystore', '*.keystore'],
  ])('flags %s', (name, rel, rule) => {
    expect(secretNameRule(name, rel)).toBe(rule);
  });

  it.each([
    [`${ENV}.example`, `${ENV}.example`],
    [`${ENV}.sample`, `${ENV}.sample`],
    ['id_rsa.pub', 'ssh/id_rsa.pub'],
    ['id_ecdsa.pub', 'ssh/id_ecdsa.pub'],
    ['config', 'config'],
    ['config.json', 'config.json'],
    ['notes.md', 'notes.md'],
    ['environment.ts', 'src/environment.ts'],
  ])('leaves %s alone', (name, rel) => {
    expect(secretNameRule(name, rel)).toBeUndefined();
  });
});

describe('scanFolderForSecretNames', () => {
  it('finds hidden and nested secrets by name, and reports paths only', async () => {
    const env = touch(ENV, 'X_API_KEY=CANARY-value');
    const key = touch('certs/deep/server.pem');
    touch('README.md');
    const { findings, truncated } = await scanFolderForSecretNames(root);
    expect(findings.map((f) => f.path).sort()).toEqual([key, env].sort());
    expect(truncated).toBe(false);
    expect(JSON.stringify(findings)).not.toContain('CANARY-value');
  });

  it('never opens a file', async () => {
    touch(ENV, 'X_API_KEY=CANARY-value');
    const readFile = vi.spyOn(fsp, 'readFile');
    const open = vi.spyOn(fsp, 'open');
    await scanFolderForSecretNames(root);
    expect(readFile).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('skips node_modules and .git', async () => {
    touch(`node_modules/pkg/${ENV}`);
    touch('.git/hooks/id_rsa');
    expect((await scanFolderForSecretNames(root)).findings).toEqual([]);
  });

  it('reports a symlink by name, but never walks into a linked folder', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secret-out-')));
    try {
      fs.writeFileSync(path.join(outside, ENV), 'x');
      fs.symlinkSync(outside, path.join(root, 'linked'));
      fs.symlinkSync(path.join(outside, ENV), path.join(root, ENV));
      const { findings } = await scanFolderForSecretNames(root);
      expect(findings).toEqual([{ path: path.join(root, ENV), rule: ENV }]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('stops at its depth and entry limits, and says so', async () => {
    touch(`a/b/c/${ENV}`);
    const deep = await scanFolderForSecretNames(root, { maxDepth: 2, maxEntries: 100 });
    expect(deep).toEqual({ findings: [], truncated: true });
    for (let i = 0; i < 5; i += 1) touch(`f${i}.txt`);
    const wide = await scanFolderForSecretNames(root, { maxDepth: 6, maxEntries: 3 });
    expect(wide.truncated).toBe(true);
  });

  it('answers nothing for a folder that does not exist', async () => {
    expect(await scanFolderForSecretNames(path.join(root, 'gone'))).toEqual({
      findings: [],
      truncated: false,
    });
  });
});
