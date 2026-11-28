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
import { runMarketplaceLink, type MarketplaceLinkArgs } from '../commands/marketplace-link.js';
import { describeUnlink } from '../commands/marketplace-unlink.js';

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

/** The approval text the preview hands back, which the yes binds to. */
const CHANGE = 'Folder: /x\nExtensions it may run: none';

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
    change: CHANGE,
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

describe('runMarketplaceLink', () => {
  it('shows the preview, asks, and links the real path from the terminal', async () => {
    confirmMock.mockResolvedValueOnce(true);
    fetchMock
      .mockResolvedValueOnce(mockResponse(200, preview()))
      .mockResolvedValueOnce(mockResponse(201, STATUS()));

    expect(await runMarketplaceLink(args())).toBe(0);

    expect(confirmMock).toHaveBeenCalledWith(`Run flow from ${realFolder}?`);
    expect(call(0).url).toMatch(/\/api\/marketplace\/dev-links\/previews$/);
    // The link the person typed is resolved: the folder shown is the folder linked.
    expect(call(0).body).toEqual({ path: realFolder, scope: 'global' });
    expect(call(1).url).toMatch(/\/api\/marketplace\/dev-links$/);
    // The yes is bound to the preview the person read, not to the folder as it
    // reads when the request lands.
    expect(call(1).body).toEqual({
      path: realFolder,
      scope: 'global',
      via: 'terminal',
      expectedChange: CHANGE,
    });
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

  it('refuses to link without a keyboard or --yes', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    fetchMock.mockResolvedValueOnce(mockResponse(200, preview()));

    expect(await runMarketplaceLink(args())).toBe(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(printedErr()).toContain('--yes');
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
      expectedChange: CHANGE,
    });
    // The preview is asked with the replace choice, so its text matches the link's.
    expect(call(0).body).toMatchObject({ replaceInstalled: true });
    expect(printed()).toContain('Sets aside the installed copy (1.0.0)');
    expect(printed()).toContain(
      `To get it back, run: dorkos marketplace unlink flow --project ${project}`
    );
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

  it('says plainly that the folder changed when the server refuses the stale yes', async () => {
    // Purpose: a folder that gained a hook while the question waited is
    // refused; the person is told what happened and what to do, not a code.
    confirmMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce(mockResponse(200, preview())).mockResolvedValueOnce(
      mockResponse(412, {
        type: 'urn:dorkos:problem:precondition_failed',
        title: 'Something changed since you last looked.',
        status: 412,
        code: 'precondition_failed',
        detail: 'The folder changed after you approved it. Ask again.',
      })
    );

    expect(await runMarketplaceLink(args())).toBe(1);

    expect(printedErr()).toBe(
      'Nothing was linked. The folder changed since you checked it. Run the command again.'
    );
    expect(printed()).not.toContain('now runs from');
  });
});

describe('marketplace unlink', () => {
  it('does not call the package removed when something else holds its place', () => {
    // Purpose: unlink left that other thing alone; "removed" would claim more
    // than happened.
    expect(describeUnlink('flow', { restored: 'removed', leftInPlace: true })).toEqual([
      'Unlinked flow. Your folder was not touched.',
      'Something else had already taken its place, and that was left as it is.',
    ]);
  });
});
