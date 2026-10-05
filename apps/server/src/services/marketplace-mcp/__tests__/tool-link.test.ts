/**
 * `marketplace_link`'s handler and card description (DOR-2696): what they pass
 * to the dev-link service, and how a refusal reaches the agent.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initBoundary } from '../../../lib/boundary.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import { DevLinkError, type DevLinkService } from '../../marketplace/dev-links/index.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';
import { createLinkHandler, describeLinkApproval } from '../tool-link.js';

let base: string;
let link: ReturnType<typeof vi.fn>;
let describeApproval: ReturnType<typeof vi.fn>;

function deps(): MarketplaceMcpDeps {
  return {
    devLinks: { link, describeApproval } as unknown as DevLinkService,
  } as MarketplaceMcpDeps;
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'tool-link-')));
  await initBoundary(base);
  link = vi.fn(async () => ({ name: 'flow' }));
  describeApproval = vi.fn(async () => 'Folder: /work/flow');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('marketplace_link handler', () => {
  it('records an approved agent call as made on a card, and links only what was described', async () => {
    // Purpose: the record says where the yes came from, no projectPath means
    // every session, and the link is held to the card's description.
    await createLinkHandler(deps())({ path: '/work/flow' }, { trusted: false });
    expect(link).toHaveBeenCalledWith({
      path: '/work/flow',
      scope: 'global',
      via: 'agent-card',
      expectedChange: 'Folder: /work/flow',
    });
  });

  it('records a trusted caller as the terminal, at project scope', async () => {
    // Purpose: projectPath picks project scope, canonicalised by the boundary.
    await createLinkHandler(deps())(
      { path: '/work/flow', projectPath: base, replaceInstalled: true },
      { trusted: true }
    );
    expect(link).toHaveBeenCalledWith({
      path: '/work/flow',
      scope: 'project',
      projectPath: base,
      replaceInstalled: true,
      via: 'terminal',
      expectedChange: 'Folder: /work/flow',
    });
  });

  it('refuses a project outside the boundary before linking anything', async () => {
    // Purpose: projectPath is where the link lands; it must stay inside.
    await expect(
      createLinkHandler(deps())(
        { path: '/work/flow', projectPath: '/definitely/elsewhere' },
        { trusted: true }
      )
    ).rejects.toBeInstanceOf(CapabilityToolError);
    expect(link).not.toHaveBeenCalled();
  });

  it('hands a refusal to the agent as its code and sentence', async () => {
    // Purpose: an agent must read "use the real path" and the path, not a stack.
    link.mockRejectedValue(
      new DevLinkError('dev_link_path_not_real', 400, 'That path is a link. Use /real instead.', {
        realPath: '/real',
      })
    );
    const err = await createLinkHandler(deps())({ path: '/alias' }, { trusted: false }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(CapabilityToolError);
    expect((err as CapabilityToolError).payload).toEqual({
      error: 'That path is a link. Use /real instead.',
      code: 'dev_link_path_not_real',
      realPath: '/real',
    });
  });

  it('describes the card from the folder, and refuses before any card when it cannot link', async () => {
    // Purpose: the approval is bound to what the card describes; a folder that
    // cannot be linked gets a refusal, never a card.
    expect(await describeLinkApproval(deps(), { path: '/work/flow' })).toBe('Folder: /work/flow');
    expect(describeApproval).toHaveBeenCalledWith({ path: '/work/flow', scope: 'global' });
    describeApproval.mockRejectedValue(
      new DevLinkError('dev_link_not_a_package', 400, 'No package found in this folder.')
    );
    await expect(describeLinkApproval(deps(), { path: '/empty' })).rejects.toBeInstanceOf(
      CapabilityToolError
    );
  });
});
