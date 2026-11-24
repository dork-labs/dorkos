/**
 * Shared setup for the extension-server-api-factory suites: everything the original file declared or
 * registered outside its tests.
 */
import { it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createDataProviderContext } from '../../extension-server-api-factory.js';

/** What each test runs against; the hooks below reset it. */
export const st = {
  mockBroadcast: undefined as unknown as ReturnType<typeof vi.fn>,
  mockLoggerError: undefined as unknown as ReturnType<typeof vi.fn>,
  tmpDir: undefined as unknown as string,
};

vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../core/event-fan-out.js', () => ({
  eventFanOut: {
    broadcast: vi.fn(),
  },
}));

export const extensionId = 'test-extension';

export const extensionDir = '/fake/ext/dir';

beforeEach(async () => {
  vi.clearAllMocks();
  st.tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-api-factory-'));

  const { eventFanOut } = await import('../../../core/event-fan-out.js');
  st.mockBroadcast = vi.mocked(eventFanOut.broadcast);

  const { logger } = await import('../../../../lib/logger.js');
  st.mockLoggerError = vi.mocked(logger.error);
});

afterEach(async () => {
  await fs.rm(st.tmpDir, { recursive: true, force: true });
});

export function buildCtx(overrides?: { extensionId?: string; dorkHome?: string }) {
  return createDataProviderContext({
    extensionId: overrides?.extensionId ?? extensionId,
    extensionDir,
    dorkHome: overrides?.dorkHome ?? st.tmpDir,
    // The inbox is fail-closed, so a ctx that uses it declares it and a
    // person allowed it.
    contributions: { inbox: true },
    allowedPlaces: () => ['inbox'],
  });
}
