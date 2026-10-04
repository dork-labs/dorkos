/**
 * Tests for `dorkos marketplace link` and `unlink` (DOR-2696): link sends the
 * folder's real path, asks first unless told not to, and an agent gets the
 * approval card's retry line instead of a link; unlink says what came back.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('../lib/confirm-prompt.js', () => ({ confirm: vi.fn() }));

import { confirm } from '../lib/confirm-prompt.js';
import {
  parseMarketplaceLinkArgs,
  runMarketplaceLink,
  type MarketplaceLinkArgs,
} from '../commands/marketplace-link.js';
import {
  describeUnlink,
  parseMarketplaceUnlinkArgs,
  runMarketplaceUnlink,
} from '../commands/marketplace-unlink.js';

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: async () => body,
  } as unknown as Response;
}

let tmp: string;
/** The real folder, and a link to it the person typed. */
let realFolder: string;
let typedFolder: string;
let logSpy: MockInstance<typeof console.log>;
let errSpy: MockInstance<typeof console.error>;
let writeSpy: MockInstance<typeof process.stdout.write>;
let fetchMock: ReturnType<typeof vi.fn>;
const confirmMock = vi.mocked(confirm);
const originalIsTTY = process.stdin.isTTY;

const printed = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const printedErr = () => errSpy.mock.calls.map((c) => String(c[0])).join('\n');

function preview(overrides: Record<string, unknown> = {}) {
  return {
    name: 'flow',
    type: 'plugin',
    version: '1.2.0',
    path: realFolder,
    scope: 'global',
    slot: '/home/u/.dork/plugins/flow',
    replaces: null,
    effects: null,
    extensions: [],
    ...overrides,
  };
}

const STATUS = () => ({
  name: 'flow',
  type: 'plugin',
  scope: 'global',
  path: realFolder,
  state: 'active',
  parked: null,
  linkedAt: '2026-10-03T00:00:00.000Z',
});

function args(overrides: Partial<MarketplaceLinkArgs> = {}): MarketplaceLinkArgs {
  return { folder: typedFolder, replaceInstalled: false, yes: false, json: false, ...overrides };
}

/** The parsed body and headers of the nth fetch call. */
function call(n: number): {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
} {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return {
    url,
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
    headers: init.headers as Record<string, string>,
  };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-link-')));
  realFolder = path.join(tmp, 'flow-src');
  fs.mkdirSync(realFolder);
  typedFolder = path.join(tmp, 'typed');
  fs.symlinkSync(realFolder, typedFolder);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('DORKOS_AGENT_TOKEN', '');
  confirmMock.mockReset();
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  writeSpy.mockRestore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseMarketplaceLinkArgs', () => {
  it('resolves the folder and the project against the working directory', () => {
    const parsed = parseMarketplaceLinkArgs([
      'plugin',
      '--project',
      'web',
      '--replace-installed',
      '-y',
      '--approval',
      'tok',
      '--json',
    ]);
    expect(parsed).toEqual({
      folder: path.resolve(process.cwd(), 'plugin'),
      projectPath: path.resolve(process.cwd(), 'web'),
      replaceInstalled: true,
      yes: true,
      approvalToken: 'tok',
      json: true,
    });
  });

  it('needs a folder, and names the command on a bad option', () => {
    expect(() => parseMarketplaceLinkArgs([])).toThrow(/Missing required <path>/);
    expect(() => parseMarketplaceLinkArgs(['x', '--nope'])).toThrow(
      /Unknown option for 'marketplace link': --nope/
    );
  });
});

describe('runMarketplaceLink', () => {
  it('shows the preview, asks, and links the real path from the terminal', async () => {
    confirmMock.mockResolvedValueOnce(true);
    fetchMock
      .mockResolvedValueOnce(mockResponse(200, preview()))
      .mockResolvedValueOnce(mockResponse(201, STATUS()));

    expect(await runMarketplaceLink(args())).toBe(0);

    expect(confirmMock).toHaveBeenCalledWith(`Run flow from ${realFolder}?`);
    expect(call(0).url).toMatch(/\/api\/marketplace\/dev-links\/preview$/);
    // The link the person typed is resolved: the folder shown is the folder linked.
    expect(call(0).body).toEqual({ path: realFolder, scope: 'global' });
    expect(call(1).url).toMatch(/\/api\/marketplace\/dev-links$/);
    expect(call(1).body).toEqual({ path: realFolder, scope: 'global', via: 'terminal' });
    expect(printed()).toContain(`Folder: ${realFolder}`);
    expect(printed()).toContain('runs nothing on its own');
    expect(printed()).toContain(`flow now runs from ${realFolder}.`);
  });

  it('links nothing when the person says no', async () => {
    confirmMock.mockResolvedValueOnce(false);
    fetchMock.mockResolvedValueOnce(mockResponse(200, preview()));

    expect(await runMarketplaceLink(args())).toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(printed()).toContain('Nothing was linked.');
  });

  it('skips the question with --yes', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(200, preview()))
      .mockResolvedValueOnce(mockResponse(201, STATUS()));

    expect(await runMarketplaceLink(args({ yes: true }))).toBe(0);

    expect(confirmMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses to link without a keyboard or --yes', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    fetchMock.mockResolvedValueOnce(mockResponse(200, preview()));

    expect(await runMarketplaceLink(args())).toBe(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(printedErr()).toContain('--yes');
  });

  it('says how to set an installed copy aside before asking anything', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, preview({ replaces: { version: '1.0.0' } })));

    expect(await runMarketplaceLink(args())).toBe(1);

    expect(confirmMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(printedErr()).toContain('--replace-installed');
  });

  it('sends a project and the replace choice, and says the installed copy is set aside', async () => {
    const project = path.join(tmp, 'web');
    fetchMock
      .mockResolvedValueOnce(
        mockResponse(200, preview({ scope: 'project', replaces: { version: '1.0.0' } }))
      )
      .mockResolvedValueOnce(
        mockResponse(201, { ...STATUS(), scope: 'project', parked: { version: '1.0.0' } })
      );

    expect(
      await runMarketplaceLink(args({ projectPath: project, replaceInstalled: true, yes: true }))
    ).toBe(0);

    expect(call(1).body).toEqual({
      path: realFolder,
      scope: 'project',
      projectPath: project,
      replaceInstalled: true,
      via: 'terminal',
    });
    expect(printed()).toContain('Sets aside the installed copy (1.0.0)');
    expect(printed()).toContain("Run 'dorkos marketplace unlink flow' to get it back.");
  });

  // The agent path: the CLI always carries the agent's identity, the server
  // answers with a card, and the retry line repeats everything the approval
  // is bound to. No local question: a person decides on the card.
  it('gives an agent the approval id and the retry line, and links nothing', async () => {
    vi.stubEnv('DORKOS_AGENT_TOKEN', 'agent-tok');
    const project = path.join(tmp, 'my web');
    fetchMock.mockResolvedValueOnce(mockResponse(200, preview())).mockResolvedValueOnce(
      mockResponse(202, {
        status: 'approval_required',
        approvalId: 'appr_1',
        approvalToken: 'appr_tok_1',
        message: 'A person has to approve this first.',
        retry: { instructions: 'Ask them to approve it in DorkOS.' },
      })
    );

    expect(await runMarketplaceLink(args({ projectPath: project, replaceInstalled: true }))).toBe(
      1
    );

    expect(confirmMock).not.toHaveBeenCalled();
    expect(call(1).headers['X-DorkOS-Agent']).toBe('agent-tok');
    const err = printedErr();
    expect(err).toContain('Approval id: appr_1');
    expect(err).toContain(
      `Retry with: dorkos marketplace link ${realFolder} --project '${project}' --replace-installed --approval appr_tok_1`
    );
    expect(printed()).not.toContain('now runs from');
  });

  it('sends the approval token on the retry without asking again', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(200, preview()))
      .mockResolvedValueOnce(mockResponse(201, STATUS()));

    expect(await runMarketplaceLink(args({ approvalToken: 'appr_tok_1' }))).toBe(0);

    expect(confirmMock).not.toHaveBeenCalled();
    expect(call(1).headers['X-DorkOS-Approval']).toBe('appr_tok_1');
  });

  it('says so when the folder does not exist, without calling DorkOS', async () => {
    expect(await runMarketplaceLink(args({ folder: path.join(tmp, 'nope') }))).toBe(1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(printedErr()).toContain('No folder at');
  });

  it('prints the server refusal as it is', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(400, {
        error: "That folder isn't a package.",
        code: 'dev_link_not_a_package',
      })
    );

    expect(await runMarketplaceLink(args())).toBe(1);

    expect(printedErr()).toContain("Error: That folder isn't a package.");
  });
});

describe('marketplace unlink', () => {
  it('parses a name and a project', () => {
    expect(parseMarketplaceUnlinkArgs(['flow', '--project', 'web'])).toEqual({
      name: 'flow',
      projectPath: path.resolve(process.cwd(), 'web'),
      json: false,
    });
    expect(() => parseMarketplaceUnlinkArgs([])).toThrow(/Missing required <name>/);
  });

  it('says the installed copy is back', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { restored: 'installed' }));

    expect(await runMarketplaceUnlink({ name: 'flow', projectPath: '/w', json: false })).toBe(0);

    expect(call(0).url).toMatch(/\/api\/marketplace\/dev-links\/flow\/unlink$/);
    expect(call(0).body).toEqual({ scope: 'project', projectPath: '/w' });
    expect(printed()).toBe('Your installed copy of flow is back.');
  });

  it('says the package is gone and the folder untouched', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { restored: 'removed' }));

    expect(await runMarketplaceUnlink({ name: 'flow', json: false })).toBe(0);

    expect(printed()).toBe('flow removed. Your folder was not touched.');
  });

  it('says where an installed copy that could not go back is', () => {
    expect(describeUnlink('flow', { restored: 'removed', parkedLeftAt: '/p/flow.parked' })).toEqual(
      [
        'Unlinked flow. Your folder was not touched.',
        "Your installed copy couldn't go back because something else is in its place. It is still at /p/flow.parked.",
      ]
    );
  });

  it("prints the route's refusal for an agent", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(403, {
        error: 'Only you can unlink a dev link, not an agent.',
        code: 'operator_only',
      })
    );

    expect(await runMarketplaceUnlink({ name: 'flow', json: false })).toBe(1);

    expect(printedErr()).toContain('Only you can unlink a dev link, not an agent.');
  });
});
