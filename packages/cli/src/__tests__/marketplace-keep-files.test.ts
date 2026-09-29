/**
 * Tests for `dorkos marketplace keep-files` (DOR-2341): a person claims the
 * files an update kept but nothing could sort, after seeing them, and, for a
 * held-back global package, after seeing everything it runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  parseMarketplaceKeepFilesArgs,
  runMarketplaceKeepFiles,
} from '../commands/marketplace-keep-files.js';

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: async () => body,
  } as unknown as Response;
}

const EFFECTS = {
  hooks: [{ event: 'Stop', matcher: null, command: 'echo hi', source: null }],
  schedules: [],
  mcpServers: [],
  lspServers: [],
  monitors: [],
  executables: [],
  skillTools: [],
  skillCommands: [],
};

const UNPROVEN = {
  files: ['notes/old.md', 'skills/old/SKILL.md'],
  running: ['skills/old/SKILL.md'],
  check: { source: 'local' },
  keepKey: 'sha256:kept',
};

/** A global install whose update kept files, held back from sessions. */
const ROW = {
  name: 'flow',
  version: '1.0.0',
  type: 'plugin',
  installPath: '/home/u/.dork/plugins/flow',
  scope: 'global',
  heldBack: { reason: 'unasked', reviewable: true, note: 'Held back.' },
  integrity: { status: 'clean', customized: [], unproven: UNPROVEN },
};

const HELD = { name: 'flow', effects: EFFECTS, bindsTo: 'sha256:pkg', changedSinceApproval: false };

let logSpy: MockInstance<typeof console.log>;
let errSpy: MockInstance<typeof console.error>;
const printed = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const errors = () => errSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('parseMarketplaceKeepFilesArgs', () => {
  it('needs a package name', () => {
    expect(() => parseMarketplaceKeepFilesArgs([])).toThrow('Name the package');
  });
});

describe('runMarketplaceKeepFiles', () => {
  // Purpose: the yes is bound to what was printed: the key the listing carried,
  // and for a held-back global package, the disclosure and binding it showed.
  it('prints the files and what the package runs, then keeps them bound to what it showed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { packages: [ROW] }))
      .mockResolvedValueOnce(mockResponse(200, { packages: [HELD] }))
      .mockResolvedValueOnce(
        mockResponse(200, {
          outcome: 'kept',
          approved: true,
          files: UNPROVEN.files,
          message: 'The 2 files flow kept are yours now.',
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    expect(await runMarketplaceKeepFiles({ name: 'flow', yes: true, json: false })).toBe(0);

    expect(printed()).toContain('skills/old/SKILL.md (runs)');
    expect(printed()).toContain('notes/old.md');
    expect(printed()).toContain('echo hi');
    expect(printed()).toContain('The 2 files flow kept are yours now.');
    const sent = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(fetchMock.mock.calls[2][0]).toContain('/api/marketplace/packages/flow/keep-files');
    expect(sent).toEqual({
      installRoot: ROW.installPath,
      keepKey: 'sha256:kept',
      review: { effects: EFFECTS, bindsTo: 'sha256:pkg' },
    });
  });

  it('asks first, and changes nothing without a yes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { packages: [ROW] }))
      .mockResolvedValueOnce(mockResponse(200, { packages: [HELD] }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await runMarketplaceKeepFiles({ name: 'flow', yes: false, json: false })).toBe(0);
    expect(printed()).toContain('Nothing was changed.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends no review for a package that is not held back', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { packages: [{ ...ROW, heldBack: undefined }] }))
      .mockResolvedValueOnce(
        mockResponse(200, { outcome: 'kept', files: UNPROVEN.files, message: 'Kept.' })
      );
    vi.stubGlobal('fetch', fetchMock);

    expect(await runMarketplaceKeepFiles({ name: 'flow', yes: true, json: false })).toBe(0);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      installRoot: ROW.installPath,
      keepKey: 'sha256:kept',
    });
  });

  // Purpose: Check files comes first where it can help, since it sets
  // leftovers aside; keeping is for kept files it cannot sort.
  it('sends a person to Check files first when it can still sort the files', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(200, {
        packages: [
          {
            ...ROW,
            integrity: {
              status: 'clean',
              customized: [],
              unproven: { ...UNPROVEN, check: { source: 'fetchable' } },
            },
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await runMarketplaceKeepFiles({ name: 'flow', yes: true, json: false })).toBe(0);
    expect(printed()).toContain('dorkos marketplace check-files flow');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('says so when there is nothing to keep, or no such package', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          mockResponse(200, {
            packages: [{ ...ROW, integrity: { status: 'clean', customized: [] } }],
          })
        )
        .mockResolvedValueOnce(mockResponse(200, { packages: [] }))
    );

    expect(await runMarketplaceKeepFiles({ name: 'flow', yes: true, json: false })).toBe(0);
    expect(printed()).toContain('flow has no kept files to sort.');
    expect(await runMarketplaceKeepFiles({ name: 'flow', yes: true, json: false })).toBe(1);
    expect(errors()).toContain('flow is not installed');
  });

  // Purpose: under sign-in a terminal holds an API key an agent may hold too,
  // so the person is sent to the app instead.
  it('points to the app when sign-in is on, and passes on a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(mockResponse(200, { packages: [{ ...ROW, heldBack: undefined }] }))
        .mockResolvedValueOnce(
          mockResponse(403, { error: 'sign-in', code: 'operator_cookie_required' })
        )
        .mockResolvedValueOnce(mockResponse(200, { packages: [{ ...ROW, heldBack: undefined }] }))
        .mockResolvedValueOnce(
          mockResponse(409, {
            error: 'The files flow kept changed since you looked, so nothing was changed.',
            code: 'kept_files_changed',
          })
        )
    );

    expect(await runMarketplaceKeepFiles({ name: 'flow', yes: true, json: false })).toBe(1);
    expect(errors()).toContain('press Keep these as mine on flow');
    expect(await runMarketplaceKeepFiles({ name: 'flow', yes: true, json: false })).toBe(1);
    expect(errors()).toContain('changed since you looked');
  });
});
