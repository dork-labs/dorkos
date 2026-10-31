import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { APPROVAL_DETAIL_MAX_LENGTH } from '@dorkos/shared/approval-schemas';
import type { DisclosedEffects } from '@dorkos/shared/marketplace-schemas';
import { TokenConfirmationProvider } from '../confirmation-provider.js';
import { ApprovalService } from '../../core/approvals/index.js';
import type { ApprovableUpdate } from '../../marketplace/flows/update-installed.js';
import { describeUpdatesInFull } from '../update-approval-detail.js';
import { planMarketplaceCard } from '../approval-summary-card.js';
import { MarketplaceCardNotStorableError } from '../../core/approvals/approval-storable.js';
import {
  NOTHING,
  bulkyUnchanged,
  flowSizedPreview,
  fortyOneNewRows,
  sixtyRowPreview,
} from './fixtures/large-packages.js';

/**
 * DOR-3070 / DOR-3356: a Marketplace card whose full list is too long for
 * `detail` gets a summary card instead of a refusal, bound to the full
 * disclosure, with the full list one link away.
 */
describe('Marketplace summary approval card', () => {
  let approvals: ApprovalService;
  let provider: TokenConfirmationProvider;

  beforeEach(() => {
    approvals = new ApprovalService(createTestDb());
    provider = new TokenConfirmationProvider(approvals);
  });

  const install = (preview = flowSizedPreview()) => ({
    packageName: 'sample-flow',
    marketplace: 'sample-market',
    operation: 'install' as const,
    packageType: 'plugin',
    preview,
    contentHash: 'sha256:staged',
    origin: { version: '0.66.1', source: 'sample-market' },
  });

  function update(overrides: Partial<ApprovableUpdate> = {}): ApprovableUpdate {
    return {
      packageName: 'sample-flow',
      installPath: '/home/.dork/plugins/sample-flow',
      type: 'plugin',
      scope: 'global',
      installedVersion: '0.66.0',
      latestVersion: '0.66.1',
      disclosed: bulkyUnchanged(),
      installedDisclosed: bulkyUnchanged(),
      contentHash: 'sha256:new',
      ...overrides,
    };
  }

  const updateRequest = (updates: ApprovableUpdate[]) => ({
    packageName: updates.map((u) => u.packageName).join(', '),
    operation: 'update' as const,
    updates,
  });

  /** The one pending card. */
  function card() {
    const pending = approvals.listPending();
    expect(pending).toHaveLength(1);
    return pending[0]!;
  }

  /** Every row on the one pending card, across its packages. */
  const rows = () => card().marketplaceSummary!.packages.flatMap((pkg) => pkg.risks);

  describe('install', () => {
    it('asks with a summary card rather than refusing a Flow-sized package', async () => {
      const result = await provider.requestInstallConfirmation(install());

      expect(result.status).toBe('pending');
      const pending = card();
      expect(pending.marketplaceSummary?.operation).toBe('install');
      expect(pending.detail!.length).toBeLessThanOrEqual(APPROVAL_DETAIL_MAX_LENGTH);
      // A card with a detail never offers Always allow, summary or not.
      expect(pending.alwaysOffered).toBe(false);
    });

    it('puts an extension with server code first, as full access to DorkOS', async () => {
      await provider.requestInstallConfirmation(install());

      const [first] = rows();
      expect(first).toMatchObject({ kind: 'extension', change: 'new' });
      expect(first!.text).toContain('"sample-flow-panel"');
      expect(first!.text).toContain('full access to DorkOS');
    });

    it('keeps the full list, uncut, behind the link', async () => {
      await provider.requestInstallConfirmation(install());

      const full = approvals.fullDetail(card().approvalId);
      expect(full).toBeDefined();
      expect(full!.length).toBe(card().marketplaceSummary!.fullDetailLength);
      expect(full!.length).toBeGreaterThan(APPROVAL_DETAIL_MAX_LENGTH);
      // Every one of the 36 skills and commands is in it, whole.
      expect(full!.match(/may use without asking/g)).toHaveLength(36);
      expect(full!.endsWith('…')).toBe(false);
    });

    it('lists every row that runs code or reaches out, and every skill’s tools', async () => {
      await provider.requestInstallConfirmation(install());

      const kinds = rows().map((row) => row.kind);
      expect(kinds.filter((k) => k === 'hook')).toHaveLength(2);
      expect(kinds.filter((k) => k === 'schedule')).toHaveLength(5);
      expect(kinds.filter((k) => k === 'skillTools')).toHaveLength(36);
      expect(kinds).toContain('host');
      expect(kinds).toContain('secret');
      expect(rows().every((row) => row.change === 'new')).toBe(true);
    });

    it('refuses in chat past 40 rows that run code, pointing at Marketplace', async () => {
      const result = await provider.requestInstallConfirmation(install(sixtyRowPreview()));

      expect(result.status).toBe('declined');
      if (result.status !== 'declined') throw new Error('unreachable');
      expect(result.reason).toContain('Too much to approve in chat');
      expect(result.reason).toContain('60 things that run code');
      expect(result.reason).toContain('install it from Marketplace');
      expect(approvals.listPending()).toEqual([]);
    });

    it('asks again when the package is swapped after the card was shown', async () => {
      const issued = await provider.requestInstallConfirmation(install());
      if (issued.status !== 'pending') throw new Error('expected pending');
      approvals.grant(card().approvalId);

      // Same card, other bytes: the yes was bound to the staged files.
      const swapped = await provider.resolveToken(issued.token, {
        ...install(),
        contentHash: 'sha256:swapped',
      });
      expect(swapped.status).toBe('pending');

      // The binding is the full disclosure, so the untouched request is approved.
      const fresh = await provider.requestInstallConfirmation(install());
      if (fresh.status !== 'pending') throw new Error('expected pending');
      const id = approvals.listPending().at(-1)!.approvalId;
      approvals.grant(id);
      expect(await provider.resolveToken(fresh.token, install())).toEqual({ status: 'approved' });
    });

    it('writes a command with direction-changing characters escaped', async () => {
      const preview = flowSizedPreview();
      preview.hooks = [{ event: 'Stop', command: 'echo safe‮; rm -rf ~' }];
      await provider.requestInstallConfirmation(install(preview));

      const hook = rows().find((row) => row.kind === 'hook')!;
      expect(hook.command).toContain('<U+202E>');
      expect(hook.command).not.toContain('‮');
    });
  });

  describe('update', () => {
    const withHook = (command: string, event = 'Stop'): DisclosedEffects => ({
      ...bulkyUnchanged(),
      hooks: [{ event, matcher: null, command, source: null }],
    });

    it('asks with a summary card rather than telling a person to update fewer at a time', async () => {
      const result = await provider.requestInstallConfirmation(updateRequest([update()]));

      expect(result.status).toBe('pending');
      expect(describeUpdatesInFull([update()]).length).toBeGreaterThan(APPROVAL_DETAIL_MAX_LENGTH);
      const [pkg] = card().marketplaceSummary!.packages;
      expect(pkg).toMatchObject({
        fromVersion: '0.66.0',
        toVersion: '0.66.1',
        power: 'none',
        unchangedCount: 30,
        risks: [],
      });
    });

    it('shows a changed hook command as Broader, with what it was', async () => {
      await provider.requestInstallConfirmation(
        updateRequest([
          update({
            installedDisclosed: withHook('node old.mjs'),
            disclosed: withHook('node new.mjs'),
          }),
        ])
      );

      expect(rows()).toEqual([
        expect.objectContaining({
          kind: 'hook',
          change: 'broader',
          command: '"node new.mjs"',
          was: '"node old.mjs"',
        }),
      ]);
    });

    it('shows a removed hook that could block something as Broader', async () => {
      await provider.requestInstallConfirmation(
        updateRequest([
          update({
            installedDisclosed: withHook('node deny-force-push.mjs', 'PreToolUse'),
            disclosed: bulkyUnchanged(),
          }),
        ])
      );

      const [row] = rows();
      expect(row).toMatchObject({ kind: 'hook', change: 'broader' });
      expect(row!.text).toContain('No longer runs');
      expect(card().marketplaceSummary!.packages[0]!.power).toBe('adds');
    });

    it('shows a removed hook that blocks nothing as Removed', async () => {
      await provider.requestInstallConfirmation(
        updateRequest([
          update({ installedDisclosed: withHook('node notify.mjs'), disclosed: bulkyUnchanged() }),
        ])
      );

      expect(rows()).toEqual([expect.objectContaining({ kind: 'hook', change: 'removed' })]);
      expect(card().marketplaceSummary!.packages[0]!.power).toBe('none');
    });

    it('shows everything as New when the installed copy cannot be vouched for', async () => {
      // `installedDisclosed` is set only for an install whose files still match.
      const modified = update({ installedDisclosed: undefined, disclosed: withHook('node x.mjs') });
      await provider.requestInstallConfirmation(updateRequest([modified]));

      const [pkg] = card().marketplaceSummary!.packages;
      expect(pkg!.unchangedCount).toBe(0);
      expect(pkg!.risks).toHaveLength(31);
      expect(pkg!.risks.every((risk) => risk.change === 'new')).toBe(true);
    });

    it('treats an extension-only update as Broader, never the lighter card', async () => {
      await provider.requestInstallConfirmation(
        updateRequest([
          update({
            extensions: [
              {
                id: 'sample-panel',
                slots: [],
                hasServer: true,
                isolation: {
                  runtime: 'subprocess',
                  net: ['api.sample.invalid'],
                  run: [],
                  agents: false,
                },
              },
            ],
          }),
        ])
      );

      const [pkg] = card().marketplaceSummary!.packages;
      expect(pkg!.power).toBe('adds');
      expect(pkg!.risks).toEqual([
        expect.objectContaining({
          kind: 'extension',
          change: 'broader',
          items: ['Contacts "api.sample.invalid"'],
        }),
      ]);
    });

    it('refuses a 41-row update in chat, and says so for one package', async () => {
      const result = await provider.requestInstallConfirmation(
        updateRequest([update({ installedDisclosed: NOTHING, disclosed: fortyOneNewRows() })])
      );

      expect(result.status).toBe('declined');
      if (result.status !== 'declined') throw new Error('unreachable');
      expect(result.reason).toContain('41 things that run code');
      expect(result.reason).toContain('update it from Marketplace');
      expect(result.reason).not.toContain('fewer at a time');
      expect(approvals.listPending()).toEqual([]);
    });

    it('asks about exactly 40 such rows', async () => {
      const forty = { ...NOTHING, hooks: fortyOneNewRows().hooks.slice(0, 40) };
      const result = await provider.requestInstallConfirmation(
        updateRequest([update({ installedDisclosed: NOTHING, disclosed: forty })])
      );

      expect(result.status).toBe('pending');
    });

    it('keeps a fitting update on today’s full card, with no summary', async () => {
      await provider.requestInstallConfirmation(
        updateRequest([update({ disclosed: NOTHING, installedDisclosed: NOTHING })])
      );

      expect(card().marketplaceSummary).toBeUndefined();
      expect(approvals.fullDetail(card().approvalId)).toBeUndefined();
    });
  });

  describe('a summary that cannot be stored whole fails closed (Security, #3356)', () => {
    /** One host the redactor leaves alone, far past a row's 4,000-character bound. */
    const longHost = Array.from({ length: 2000 }, (_, i) => `l${i % 10}`).join('.');
    const withLongHost = () => ({ ...flowSizedPreview(), externalHosts: [longHost] });

    it('raises no card, and nothing can be approved', async () => {
      const result = await provider.requestInstallConfirmation(install(withLongHost()));

      expect(result.status).toBe('declined');
      if (result.status !== 'declined') throw new Error('unreachable');
      expect(result.reason).toContain('Too much to approve in chat');
      expect(approvals.listPending()).toEqual([]);
    });

    it('is refused by the planner on its own', () => {
      const req = install(withLongHost());
      const plan = planMarketplaceCard(req, 'x'.repeat(APPROVAL_DETAIL_MAX_LENGTH + 1));
      expect(plan.kind).toBe('refuse');
    });

    it('is refused by the approval store on its own, for any caller', () => {
      const summary = {
        operation: 'install' as const,
        fullDetailLength: 10,
        packages: [
          {
            name: 'sample',
            where: 'plugin, installed globally',
            toVersion: '1.0.0',
            power: 'adds' as const,
            unchangedCount: 0,
            risks: [
              { kind: 'host' as const, change: 'new' as const, text: `Contacts ${longHost}` },
            ],
          },
        ],
      };

      expect(() =>
        approvals.request({
          capabilityId: 'marketplace.install',
          inputHash: 'sha256:any',
          summary: 'Install "sample"',
          detail: 'cut',
          marketplace: { summary, fullDetail: 'all of it' },
        })
      ).toThrow(MarketplaceCardNotStorableError);
      expect(approvals.listPending()).toEqual([]);
    });
  });

  it('serves the full list only while the card is answerable', async () => {
    await provider.requestInstallConfirmation(install());
    const id = card().approvalId;
    expect(approvals.fullDetail(id)).toBeDefined();

    approvals.deny(id);
    expect(approvals.fullDetail(id)).toBeUndefined();
    expect(approvals.fullDetail('no-such-approval')).toBeUndefined();
  });
});
