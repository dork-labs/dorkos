import { describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalService } from '../../core/approvals/index.js';
import { disclosedEffectsOf } from '../../marketplace/preview/disclosed-effects.js';
import { extensionDeclarationLines } from '../../marketplace/preview/extension-disclosure.js';
import { TokenConfirmationProvider } from '../confirmation-provider.js';
import { emptyPreview, flowSizedPreview, NOTHING } from './fixtures/large-packages.js';

describe('package card disclosure', () => {
  it('uses the dialog labels and leaves ordinary declaration values unquoted', () => {
    expect(
      extensionDeclarationLines({
        id: 'sample-app',
        slots: ['pages'],
        hasServer: true,
        isolation: {
          runtime: 'subprocess',
          net: ['api.example.test'],
          run: ['node', 'git'],
          agents: true,
        },
        secrets: [{ key: 'sample_key', required: true }],
      })
    ).toEqual([
      'Shows in: pages',
      'Runs separately from DorkOS.',
      'Can connect to: api.example.test',
      'Can run: node, git',
      'Can run node, which can run any program.',
      'Can message your agents and start chats.',
      'Secrets: sample_key (required)',
    ]);
  });

  it('keeps unusual declaration values quoted and hidden characters visible', () => {
    const lines = extensionDeclarationLines({
      id: 'sample-app',
      slots: ['pages\nother', 'pages\u202E'],
      hasServer: true,
      isolation: {
        runtime: 'subprocess',
        net: ['one.test, two.test', '\u0430pi.example.test'],
        run: [],
        agents: false,
      },
      secrets: [],
    });
    expect(lines).toContain('Shows in: "pages\\nother", "pages<U+202E>"');
    expect(lines).toContain('Can connect to: "one.test, two.test", "\u0430pi.example.test"');
    expect(lines).toContain('Can’t run programs.');
    expect(lines).toContain('Can’t message your agents or start chats.');
  });

  it('keeps missing app metadata visible beside a structured update', async () => {
    const approvals = new ApprovalService(createTestDb());
    const provider = new TokenConfirmationProvider(approvals);
    const base = {
      type: 'plugin',
      scope: 'global',
      installedVersion: '1.0.0',
      latestVersion: '2.0.0',
      disclosed: NOTHING,
      contentHash: 'digest-a',
    } as const;
    await provider.requestInstallConfirmation({
      packageName: 'scheduled, old-metadata',
      operation: 'update',
      updates: [
        {
          ...base,
          packageName: 'scheduled',
          installPath: '/sample/scheduled',
          extensions: [],
          disclosed: {
            ...NOTHING,
            schedules: [
              { name: 'Check', cron: '0 9 * * *', permissionMode: 'plan', startsEnabled: false },
            ],
          },
        },
        { ...base, packageName: 'old-metadata', installPath: '/sample/old' },
      ],
    });
    const old = approvals.listPending()[0]!.marketplaceSummary!.packages[1]!;
    expect(old.power).toBe('adds');
    expect(old.risks[0]!.text).toContain('This package may run server code.');
  });

  it.each(['install', 'update'] as const)(
    'lists each app on a small %s card',
    async (operation) => {
      const approvals = new ApprovalService(createTestDb());
      const provider = new TokenConfirmationProvider(approvals);
      const extensions = [
        {
          id: 'sample-board',
          slots: ['pages'],
          hasServer: true,
          isolation: {
            runtime: 'subprocess' as const,
            net: ['api.example.test'],
            run: ['node'],
            agents: true,
          },
          secrets: [{ key: 'BOARD_KEY', required: true }],
        },
        {
          id: 'sample-view',
          slots: ['right-panel'],
          hasServer: false,
          isolation: { runtime: 'in-process' as const, net: [], run: [], agents: false },
          secrets: [],
        },
      ];
      const preview = {
        ...emptyPreview(),
        extensions,
        schedules: [
          {
            name: 'Sample check',
            cron: '0 9 * * *',
            permissionMode: 'plan' as const,
            startsEnabled: false,
          },
        ],
      };
      await provider.requestInstallConfirmation({
        packageName: 'sample-pack',
        operation,
        outsideWords: true,
        ...(operation === 'install'
          ? { preview, contentHash: 'digest-a', origin: { version: '1.0.0' } }
          : {
              updates: [
                {
                  packageName: 'sample-pack',
                  type: 'plugin',
                  scope: 'global',
                  installPath: '/sample/plugins/sample-pack',
                  installedVersion: '1.0.0',
                  latestVersion: '2.0.0',
                  contentHash: 'digest-a',
                  disclosed: disclosedEffectsOf(preview),
                  extensions,
                },
              ],
            }),
      });
      const [card] = approvals.listPending();
      expect(card!.marketplaceSummary).toBeDefined();
      const risks = card!.marketplaceSummary!.packages.flatMap((pkg) => pkg.risks);
      expect(risks.find((risk) => risk.kind === 'extension')?.items).toContain(
        'Can run node, which can run any program.'
      );
      expect(risks.find((risk) => risk.kind === 'extension')?.items).toContain('Can run: node');
      expect(risks.find((risk) => risk.kind === 'schedule')?.text).toContain(
        'Every day at 9:00 AM'
      );
      expect(risks.find((risk) => risk.kind === 'schedule')?.text).toContain(
        'arrives switched off'
      );
      expect(risks.find((risk) => risk.kind === 'schedule')?.text).not.toContain('0 9 * * *');
      expect(risks.find((risk) => risk.kind === 'schedule')?.command).toBe('"0 9 * * *"');
      expect(card!.summary).toContain('This request followed words from outside your team.');
      for (const value of [
        'sample-board',
        'pages',
        'api.example.test',
        'node',
        'agents',
        'BOARD_KEY',
        'sample-view',
        'right-panel',
      ]) {
        expect(card!.detail).toContain(value);
      }
      expect(card!.detail).not.toContain('runs nothing on its own');
    }
  );

  it('says an update brings app code that waits for a fresh OK (DOR-4895)', async () => {
    const UPDATE_APP_WAITS =
      'Any new code waits for your OK in Activity, unless you trust its source.';
    const approvals = new ApprovalService(createTestDb());
    const provider = new TokenConfirmationProvider(approvals);
    const extensions = [
      {
        id: 'sample-board',
        slots: ['pages'],
        hasServer: true,
        isolation: { runtime: 'in-process' as const, net: [], run: [], agents: false },
        secrets: [],
      },
    ];
    await provider.requestInstallConfirmation({
      packageName: 'sample-pack',
      operation: 'update',
      updates: [
        {
          packageName: 'sample-pack',
          type: 'plugin',
          scope: 'agent-local',
          projectPath: '/sample/project',
          installPath: '/sample/project/.dork/plugins/sample-pack',
          installedVersion: '1.0.0',
          latestVersion: '2.0.0',
          contentHash: 'digest-b',
          disclosed: NOTHING,
          extensions,
        },
      ],
    });
    const [card] = approvals.listPending();
    const app = card!.marketplaceSummary!.packages[0]!.risks.find(
      (risk) => risk.kind === 'extension'
    );
    expect(app?.text).toContain('runs server code inside DorkOS');
    expect(app?.items).toContain(UPDATE_APP_WAITS);
    expect(approvals.fullDetail(card!.approvalId)).toContain(UPDATE_APP_WAITS);
    expect(approvals.fullDetail(card!.approvalId)).not.toContain('runs nothing on its own');
  });

  it('says it once per package for many mini apps, so a big update still gets a card (DOR-4895)', async () => {
    const approvals = new ApprovalService(createTestDb());
    const provider = new TokenConfirmationProvider(approvals);
    // Screens only, so the code-row cap stays out of it: only the text's length is tested.
    const extensions = Array.from({ length: 1200 }, (_, index) => ({
      id: `sample-screen-${String(index).padStart(4, '0')}`,
      slots: ['pages', 'right-panel'],
      hasServer: false,
      secrets: [],
    }));
    const result = await provider.requestInstallConfirmation({
      packageName: 'sample-pack',
      operation: 'update',
      updates: [
        {
          packageName: 'sample-pack',
          type: 'plugin',
          scope: 'global',
          installPath: '/sample/plugins/sample-pack',
          installedVersion: '1.0.0',
          latestVersion: '2.0.0',
          contentHash: 'digest-c',
          disclosed: NOTHING,
          extensions,
        },
      ],
    });
    expect(result).toMatchObject({ status: 'pending' });
    const [card] = approvals.listPending();
    const full = approvals.fullDetail(card!.approvalId)!;
    expect(full).not.toContain('Any new code waits for your OK');
    expect(
      full.split(
        'All 1,200 mini apps: any new code waits in Activity, unless you trust its source.'
      ).length
    ).toBe(2);
    const items = card!.marketplaceSummary!.packages[0]!.risks.flatMap((risk) => risk.items ?? []);
    expect(items.filter((item) => item.startsWith('All 1,200 mini apps'))).toHaveLength(1);
  });

  it.each([
    [3, 3, 0],
    [4, 0, 1],
  ])(
    'with %i mini apps, says the line under %i of them and %i time for the package',
    async (count, perApp, once) => {
      const approvals = new ApprovalService(createTestDb());
      const provider = new TokenConfirmationProvider(approvals);
      const extensions = Array.from({ length: count }, (_, index) => ({
        id: `sample-screen-${index}`,
        slots: ['pages'],
        hasServer: false,
        secrets: [],
      }));
      await provider.requestInstallConfirmation({
        packageName: 'sample-pack',
        operation: 'update',
        updates: [
          {
            packageName: 'sample-pack',
            type: 'plugin',
            scope: 'global',
            installPath: '/sample/plugins/sample-pack',
            installedVersion: '1.0.0',
            latestVersion: '2.0.0',
            contentHash: 'digest-d',
            disclosed: NOTHING,
            extensions,
          },
        ],
      });
      const [card] = approvals.listPending();
      const full = approvals.fullDetail(card!.approvalId) ?? card!.detail ?? '';
      expect(full.split('Any new code waits for your OK').length - 1).toBe(perApp);
      expect(full.split(`All ${count} mini apps:`).length - 1).toBe(once);
    }
  );

  it('keeps the marked-turn line and every app on a large summary card', async () => {
    const approvals = new ApprovalService(createTestDb());
    const provider = new TokenConfirmationProvider(approvals);
    const preview = flowSizedPreview();
    preview.extensions.push({ id: 'sample-screen', slots: ['pages'], hasServer: false });
    await provider.requestInstallConfirmation({
      packageName: 'sample-pack',
      operation: 'install',
      preview,
      outsideWords: true,
    });
    const [card] = approvals.listPending();
    expect(card!.marketplaceSummary).toBeDefined();
    expect(card!.summary).toContain('This request followed words from outside your team.');
    expect(JSON.stringify(card!.marketplaceSummary)).toContain('sample-screen');
    expect(approvals.fullDetail(card!.approvalId)).toContain('sample-screen');
  });

  it('keeps every app and package schedule on a large update summary', async () => {
    const approvals = new ApprovalService(createTestDb());
    const provider = new TokenConfirmationProvider(approvals);
    const preview = flowSizedPreview();
    preview.extensions.push({
      id: 'sample-screen',
      slots: ['pages'],
      hasServer: false,
      secrets: [],
    });
    await provider.requestInstallConfirmation({
      packageName: 'sample-pack',
      operation: 'update',
      outsideWords: true,
      updates: [
        {
          packageName: 'sample-pack',
          type: 'plugin',
          scope: 'global',
          installPath: '/sample/plugins/sample-pack',
          installedVersion: '1.0.0',
          latestVersion: '2.0.0',
          contentHash: 'digest-a',
          disclosed: {
            ...disclosedEffectsOf(preview)!,
            schedules: [
              {
                name: 'Sample check',
                cron: '0 9 * * *',
                permissionMode: 'plan',
                startsEnabled: false,
              },
            ],
          },
          extensions: preview.extensions,
        },
      ],
    });
    const card = approvals.listPending()[0]!;
    expect(card.marketplaceSummary).toBeDefined();
    expect(card.summary).toContain('This request followed words from outside your team.');
    expect(JSON.stringify(card.marketplaceSummary)).toContain('sample-screen');
    expect(approvals.fullDetail(card.approvalId)).toContain('Sample check');
    expect(approvals.fullDetail(card.approvalId)).toContain('arrives switched off');
  });

  it('binds the displayed package version even when the staged digest is unchanged', async () => {
    const approvals = new ApprovalService(createTestDb());
    const provider = new TokenConfirmationProvider(approvals);
    const request = {
      packageName: 'sample-pack',
      operation: 'install' as const,
      preview: emptyPreview(),
      contentHash: 'digest-a',
      origin: { version: '1.0.0' },
    };
    const issued = await provider.requestInstallConfirmation(request);
    if (issued.status !== 'pending') throw new Error('expected pending');
    approvals.grant(approvals.listPending()[0]!.approvalId);
    expect(
      await provider.resolveToken(issued.token, { ...request, origin: { version: '2.0.0' } })
    ).toMatchObject({ status: 'pending' });
  });

  it('re-asks when an old approval has no staged digest', async () => {
    const approvals = new ApprovalService(createTestDb());
    const provider = new TokenConfirmationProvider(approvals);
    const old = {
      packageName: 'sample-pack',
      operation: 'install' as const,
      preview: emptyPreview(),
      resolvedPackageName: 'sample-pack',
      origin: { version: '1.0.0' },
    };
    const issued = await provider.requestInstallConfirmation(old);
    if (issued.status !== 'pending') throw new Error('expected pending');
    approvals.grant(approvals.listPending()[0]!.approvalId);
    expect(
      await provider.resolveToken(issued.token, { ...old, contentHash: 'digest-a' })
    ).toMatchObject({ status: 'pending' });
  });

  it('binds the resolved package identity separately from its lookup alias', async () => {
    const approvals = new ApprovalService(createTestDb());
    const provider = new TokenConfirmationProvider(approvals);
    const request = {
      packageName: 'sample-alias',
      operation: 'install' as const,
      preview: emptyPreview(),
      contentHash: 'digest-a',
      resolvedPackageName: 'sample-pack',
      origin: { version: '1.0.0' },
    };
    const issued = await provider.requestInstallConfirmation(request);
    if (issued.status !== 'pending') throw new Error('expected pending');
    approvals.grant(approvals.listPending()[0]!.approvalId);
    expect(
      await provider.resolveToken(issued.token, { ...request, resolvedPackageName: 'another-pack' })
    ).toMatchObject({ status: 'pending' });
  });

  it('keeps the request-time marked-turn line after its caller continues', async () => {
    const approvals = new ApprovalService(createTestDb());
    const provider = new TokenConfirmationProvider(approvals);
    const request = {
      packageName: 'sample-pack',
      operation: 'install' as const,
      preview: emptyPreview(),
      outsideWords: true,
    };
    await provider.requestInstallConfirmation(request);
    request.outsideWords = false;
    expect(approvals.listPending()[0]!.summary).toContain(
      'This request followed words from outside your team.'
    );
  });

  it('keeps the preview declarations unchanged when the content card is approved', async () => {
    const approvals = new ApprovalService(createTestDb());
    const provider = new TokenConfirmationProvider(approvals);
    const preview = emptyPreview();
    preview.extensions = [
      {
        id: 'sample-app',
        slots: ['pages'],
        hasServer: true,
        secrets: [{ key: 'SAMPLE_KEY', required: true }],
      },
    ];
    preview.secrets = [{ key: 'SAMPLE_KEY', required: true }];
    preview.schedules = [
      { name: 'Sample check', cron: '0 9 * * *', permissionMode: 'plan', startsEnabled: false },
    ];
    const before = structuredClone(preview);
    const request = {
      packageName: 'sample-pack',
      operation: 'install' as const,
      contentHash: 'digest-a',
      preview,
    };
    const issued = await provider.requestInstallConfirmation(request);
    if (issued.status !== 'pending') throw new Error('expected pending');
    const [card] = approvals.listPending();
    const shownDetail = approvals.fullDetail(card!.approvalId);
    approvals.grant(card!.approvalId);
    expect(await provider.resolveToken(issued.token, request)).toEqual({ status: 'approved' });
    expect(preview).toEqual(before);
    expect(card!.detail).toContain('SAMPLE_KEY');
    expect(card!.detail).toContain('Sample check');
    expect(card!.detail).toContain('Every day at 9:00 AM');
    expect(shownDetail).toContain('0 9 * * *');
    expect(card!.detail).toContain('arrives switched off');
  });
});
