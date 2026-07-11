/**
 * Tests for the shared anonymous instance-id helper.
 *
 * Mocks `node:fs/promises` so reads/writes never touch disk. The id file is
 * `<dorkHome>/telemetry-install-id`, shared by every opt-in dorkos.ai channel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const { mockReadFile, mockWriteFile, mockMkdir } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
  },
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));

import { getOrCreateInstanceId, INSTANCE_ID_FILENAME } from '../instance-id.js';

const DORK_HOME = '/tmp/test-dork-home-instance-id';
const ID_PATH = path.join(DORK_HOME, INSTANCE_ID_FILENAME);

describe('getOrCreateInstanceId', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reads the existing UUID from disk when present', async () => {
    const existingId = '11111111-2222-3333-4444-555555555555';
    mockReadFile.mockResolvedValue(`${existingId}\n`);

    const id = await getOrCreateInstanceId(DORK_HOME);

    expect(id).toBe(existingId);
    expect(mockReadFile).toHaveBeenCalledWith(ID_PATH, 'utf8');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('generates and writes a new UUID when the file is missing', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const id = await getOrCreateInstanceId(DORK_HOME);

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(mockMkdir).toHaveBeenCalledWith(DORK_HOME, { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(ID_PATH, id, 'utf8');
  });

  it('returns the same UUID across two calls', async () => {
    let stored: string | null = null;
    mockReadFile.mockImplementation(async () => {
      if (stored === null) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return stored;
    });
    mockWriteFile.mockImplementation(async (_p, contents) => {
      stored = contents as string;
    });

    const first = await getOrCreateInstanceId(DORK_HOME);
    const second = await getOrCreateInstanceId(DORK_HOME);

    expect(second).toBe(first);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });
});
