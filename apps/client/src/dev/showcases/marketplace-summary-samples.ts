/**
 * Made-up Marketplace summaries for the approval card showcase (DOR-3070):
 * an update that adds power and a large install with an in-process
 * extension, shaped like what `approval-summary-card.ts` writes.
 *
 * @module dev/showcases/marketplace-summary-samples
 */
import type { PermissionPreview } from '@dorkos/shared/marketplace-schemas';
import type { MarketplaceApprovalSummary } from '@dorkos/shared/approval-schemas';

/** An update of one plugin: two rows that add power, one removed, the rest unchanged. */
export const UPDATE_SUMMARY: MarketplaceApprovalSummary = {
  operation: 'update',
  fullDetailLength: 6165,
  packages: [
    {
      name: 'sample-release-notes',
      where: 'plugin, installed globally',
      fromVersion: '2.3.1',
      toVersion: '3.0.0',
      power: 'adds',
      unchangedCount: 34,
      risks: [
        {
          kind: 'hook',
          change: 'new',
          text: 'Runs a command before the agent uses a tool ("Bash")',
          command: '"node ./hooks/guard.mjs --strict --log ~/.sample/guard.log"',
        },
        {
          kind: 'mcp',
          change: 'broader',
          text: 'Starts the MCP server "release-notes" (in every chat)',
          command: '"npx" "-y" "@sample/release-mcp@3.0.0"',
          was: '"npx" "-y" "@sample/release-mcp@2.3.1"',
        },
        {
          kind: 'hook',
          change: 'removed',
          text: 'Runs a command when the agent finishes',
          command: '"npm run notes:sync"',
        },
      ],
    },
    {
      name: 'sample-linter',
      where: 'plugin, installed globally',
      fromVersion: '1.0.0',
      toVersion: '1.0.1',
      power: 'none',
      unchangedCount: 2,
      risks: [],
    },
  ],
};

/** A fresh install of a large workflow plugin, every row New. */
export const INSTALL_SUMMARY: MarketplaceApprovalSummary = {
  operation: 'install',
  fullDetailLength: 9412,
  packages: [
    {
      name: 'sample-flow',
      where: 'plugin, installed globally',
      toVersion: '0.66.1',
      power: 'adds',
      unchangedCount: 0,
      risks: [
        {
          kind: 'extension',
          change: 'new',
          text: 'The extension "sample-flow-panel" runs server code inside DorkOS, with full access to DorkOS',
          items: ['Shows in: pages', 'Secrets: SAMPLE_TOKEN (optional)'],
        },
        {
          kind: 'hook',
          change: 'new',
          text: 'Runs a command when the agent finishes',
          command:
            '"cd \\"$(git rev-parse --show-toplevel)\\" && node \\"${CLAUDE_PLUGIN_ROOT}/hooks/sample-loop.mjs\\""',
        },
        {
          kind: 'schedule',
          change: 'new',
          text: 'Scheduled job "sample-groom": Every Monday at 9:00 AM, can edit files without asking, arrives switched off, and would wait for your approval too',
          command: '"0 9 * * 1"',
        },
        { kind: 'host', change: 'new', text: 'Contacts "api.sample.invalid"' },
        { kind: 'secret', change: 'new', text: 'Asks for the secret "SAMPLE_TOKEN" (optional)' },
        ...Array.from({ length: 36 }, (_, i) => ({
          kind: 'skillTools' as const,
          change: 'new' as const,
          text: `The skill "sample-skill-${i}" may use these without asking`,
          items: ['"Bash(git status:*)"', '"Bash(gh pr view:*)"', '"Read"'],
        })),
      ],
    },
  ],
};

/** What "See everything it runs" opens in the playground. */
export const SAMPLE_FULL_DETAIL = [
  'Asked by "DorkBot".',
  'Version "0.66.1", from "sample-market".',
  '',
  '  runs "node ./hooks/guard.mjs --strict" before the agent uses a tool ("Bash")',
  ...Array.from(
    { length: 36 },
    (_, i) =>
      `  skill "sample-skill-${i}" ("skills/sample-skill-${i}/SKILL.md") may use without asking: "Bash(git status:*)", "Bash(gh pr view:*)", "Read"`
  ),
].join('\n');

/** Per-app declarations for the package approval design checks; no live data. */
export const PACKAGE_REVIEW_APPS: PermissionPreview['extensions'] = [
  {
    id: 'sample-board',
    slots: ['pages', 'right-panel'],
    hasServer: true,
    isolation: { runtime: 'subprocess', net: ['api.sample.invalid'], run: ['node'], agents: true },
    secrets: [{ key: 'SAMPLE_BOARD_KEY', required: true }],
  },
  {
    id: 'sample-notes',
    slots: ['pages'],
    hasServer: false,
    isolation: { runtime: 'in-process', net: [], run: [], agents: false },
    secrets: [],
  },
];

/** The small content card, with each app followed by the package's schedule. */
export const PACKAGE_REVIEW_DETAIL = [
  'Mini app "sample-board":',
  '  Shows in: pages, right-panel',
  '  Can connect to: api.sample.invalid',
  '  Can run: node',
  '  Can run node, which can run any program.',
  '  Can message your agents and start chats.',
  '  Secrets: SAMPLE_BOARD_KEY (required)',
  'Mini app "sample-notes":',
  '  Shows in: pages',
  '  Only screens; no server code.',
  '  No secrets declared.',
  'Scheduled job "Sample check": Every day at 9:00 AM.',
  '  Asks before editing files. Arrives switched off.',
].join('\n');

/** The small content review uses the same structured rows as a large package. */
export const PACKAGE_REVIEW_SUMMARY: MarketplaceApprovalSummary = {
  operation: 'install',
  fullDetailLength: PACKAGE_REVIEW_DETAIL.length,
  packages: [
    {
      name: 'sample-board',
      where: 'plugin, installed globally',
      toVersion: '1.0.0',
      power: 'adds',
      unchangedCount: 0,
      risks: [
        {
          kind: 'extension',
          change: 'new',
          text: 'The mini app "sample-board" runs server code in a separate process',
          items: [
            'Shows in: pages, right-panel',
            'Runs separately from DorkOS.',
            'Can connect to: api.sample.invalid',
            'Can run: node',
            'Can run node, which can run any program.',
            'Can message your agents and start chats.',
            'Secrets: SAMPLE_BOARD_KEY (required)',
          ],
        },
        {
          kind: 'extension',
          change: 'new',
          text: 'The mini app "sample-notes" has only screens',
          items: ['Shows in: pages', 'Only screens; no server code.', 'No secrets declared.'],
        },
        {
          kind: 'schedule',
          change: 'new',
          text: 'Scheduled job "Sample check": Every day at 9:00 AM, asks before editing files, arrives switched off',
          command: '"0 9 * * *"',
        },
      ],
    },
  ],
};
