/**
 * The compiler serves only cached bundle bytes it wrote itself (DOR-3068).
 *
 * @module services/extensions/pin/__tests__/extension-bundle-vouchers
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { BundleVouchers } from '../extension-bundle-vouchers.js';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-vouchers-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('BundleVouchers', () => {
  it('reads back exactly the bytes it vouched for', async () => {
    const file = path.join(tmp, 'a.js');
    await fs.writeFile(file, 'ok');
    const vouchers = new BundleVouchers();
    vouchers.vouch(file, 'ok');
    expect(await vouchers.read(file)).toBe('ok');
  });

  it('refuses a file whose bytes changed after it was vouched for, and forgets it', async () => {
    const file = path.join(tmp, 'a.js');
    await fs.writeFile(file, 'ok');
    const vouchers = new BundleVouchers();
    vouchers.vouch(file, 'ok');
    await fs.writeFile(file, 'planted');
    expect(await vouchers.read(file)).toBeNull();
    await fs.writeFile(file, 'ok');
    expect(await vouchers.read(file)).toBeNull();
  });

  it('refuses a file it never vouched for, and one that is gone', async () => {
    const file = path.join(tmp, 'a.js');
    await fs.writeFile(file, 'ok');
    const vouchers = new BundleVouchers();
    expect(await vouchers.read(file)).toBeNull();
    vouchers.vouch(path.join(tmp, 'gone.js'), 'x');
    expect(await vouchers.read(path.join(tmp, 'gone.js'))).toBeNull();
  });
});
