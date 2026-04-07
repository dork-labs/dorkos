/**
 * Mock fixtures for marketplace component showcases.
 *
 * All shapes match the real TypeScript interfaces from
 * `@dorkos/shared/marketplace-schemas`. No `displayName`, `installCount`,
 * `updatedAt` (not on `AggregatedPackage`), no `source`/`updateAvailable` (not
 * on `InstalledPackage`), no `url`/`packageCount`/`lastRefreshed` (not on
 * `MarketplaceSource`).
 *
 * @module dev/showcases/marketplace-mocks
 */
import type {
  AggregatedPackage,
  InstalledPackage,
  MarketplaceSource,
  PermissionPreview,
} from '@dorkos/shared/marketplace-schemas';

// ---------------------------------------------------------------------------
// AggregatedPackage mocks
// ---------------------------------------------------------------------------

/** Featured agent package — star indicator, type badge, description clamped. */
export const MOCK_PKG_FEATURED_AGENT: AggregatedPackage = {
  name: 'code-reviewer',
  source: 'https://github.com/dorkos-marketplace/code-reviewer',
  marketplace: 'dorkos-official',
  description:
    'Automated code review that surfaces style violations, security issues, and performance hints directly in your workflow.',
  version: '1.4.2',
  type: 'agent',
  featured: true,
  icon: '🔍',
  category: 'dev-tools',
  tags: ['code-review', 'quality', 'ci'],
};

/** Plain plugin package — no featured indicator. */
export const MOCK_PKG_PLUGIN: AggregatedPackage = {
  name: 'obsidian-sync',
  source: 'https://github.com/dorkos-marketplace/obsidian-sync',
  marketplace: 'dorkos-official',
  description: 'Bidirectional sync between DorkOS agent sessions and your Obsidian vault.',
  version: '0.8.1',
  type: 'plugin',
  icon: '🗒️',
  category: 'integration',
  tags: ['obsidian', 'notes', 'sync'],
};

/** Skill pack — no description to exercise the no-description branch. */
export const MOCK_PKG_SKILL_PACK_NO_DESC: AggregatedPackage = {
  name: 'python-skills',
  source: 'https://github.com/dorkos-marketplace/python-skills',
  marketplace: 'dorkos-official',
  type: 'skill-pack',
  icon: '🐍',
};

/** Adapter package with long description to test line-clamp. */
export const MOCK_PKG_ADAPTER_LONG_DESC: AggregatedPackage = {
  name: 'slack-adapter',
  source: 'https://github.com/dorkos-marketplace/slack-adapter',
  marketplace: 'community-registry',
  description:
    'Full Slack integration: receive DMs, reply from agent, post to channels, react to mentions, schedule digests, and surface thread summaries — all without leaving your workflow.',
  version: '2.1.0',
  type: 'adapter',
  icon: '💬',
  category: 'messaging',
  tags: ['slack', 'messaging', 'notifications'],
};

/** Featured agent for the FeaturedAgentsRail — second slot. */
export const MOCK_PKG_FEATURED_DEPLOY: AggregatedPackage = {
  name: 'deploy-bot',
  source: 'https://github.com/dorkos-marketplace/deploy-bot',
  marketplace: 'dorkos-official',
  description: 'Orchestrates CI/CD pipelines, monitors deployments, and pages on failure.',
  version: '3.0.0',
  type: 'agent',
  featured: true,
  icon: '🚀',
  category: 'devops',
  tags: ['deploy', 'ci', 'cd'],
};

/** Featured agent for the FeaturedAgentsRail — third slot. */
export const MOCK_PKG_FEATURED_DOCS: AggregatedPackage = {
  name: 'doc-writer',
  source: 'https://github.com/dorkos-marketplace/doc-writer',
  marketplace: 'dorkos-official',
  description:
    'Auto-generates API docs, README files, and architecture decision records from your codebase.',
  version: '1.1.0',
  type: 'agent',
  featured: true,
  icon: '📝',
  category: 'documentation',
};

/** Full catalog of 8 packages used by the PackageGrid loaded-state showcase. */
export const MOCK_PACKAGES: AggregatedPackage[] = [
  MOCK_PKG_FEATURED_AGENT,
  MOCK_PKG_FEATURED_DEPLOY,
  MOCK_PKG_FEATURED_DOCS,
  MOCK_PKG_PLUGIN,
  MOCK_PKG_SKILL_PACK_NO_DESC,
  MOCK_PKG_ADAPTER_LONG_DESC,
  {
    name: 'github-actions-skill',
    source: 'https://github.com/dorkos-marketplace/github-actions-skill',
    marketplace: 'community-registry',
    description: 'SKILL.md definitions for common GitHub Actions workflows.',
    version: '1.0.0',
    type: 'skill-pack',
    icon: '⚙️',
    tags: ['github', 'ci', 'skills'],
  },
  {
    name: 'linear-agent',
    source: 'https://github.com/dorkos-marketplace/linear-agent',
    marketplace: 'dorkos-official',
    description: 'Manages Linear issues, triages inbox, and auto-closes resolved tickets.',
    version: '0.5.0',
    type: 'agent',
    icon: '🔷',
    tags: ['linear', 'project-management', 'triage'],
  },
];

// ---------------------------------------------------------------------------
// PermissionPreview mocks
// ---------------------------------------------------------------------------

/** Minimal preview — no secrets, no external hosts, no conflicts. */
export const MOCK_PERMISSION_PREVIEW_MINIMAL: PermissionPreview = {
  fileChanges: [
    { path: '.dork/agents/code-reviewer/agent.json', action: 'create' },
    { path: '.dork/agents/code-reviewer/SKILL.md', action: 'create' },
  ],
  extensions: [{ id: 'code-reviewer-ext', slots: ['sidebar', 'chat-toolbar'] }],
  tasks: [{ name: 'nightly-review', cron: '0 2 * * *' }],
  secrets: [],
  externalHosts: [],
  requires: [{ type: 'skill-pack', name: 'python-skills', version: '>=1.0.0', satisfied: true }],
  conflicts: [],
};

/** Full preview with all sections populated. */
export const MOCK_PERMISSION_PREVIEW_FULL: PermissionPreview = {
  fileChanges: [
    { path: '.dork/agents/deploy-bot/agent.json', action: 'create' },
    { path: '.dork/agents/deploy-bot/config.json', action: 'create' },
    { path: '.dork/data/deploy-bot/', action: 'create' },
  ],
  extensions: [{ id: 'deploy-bot-ext', slots: ['dashboard-panel', 'task-runner'] }],
  tasks: [
    { name: 'health-check', cron: '*/15 * * * *' },
    { name: 'nightly-report', cron: '0 3 * * *' },
  ],
  secrets: [
    {
      key: 'GITHUB_TOKEN',
      required: true,
      description: 'GitHub Personal Access Token for repo access',
    },
    {
      key: 'SLACK_WEBHOOK',
      required: false,
      description: 'Optional Slack webhook for failure alerts',
    },
  ],
  externalHosts: ['api.github.com', 'hooks.slack.com'],
  requires: [{ type: 'adapter', name: 'slack-adapter', version: '>=2.0.0', satisfied: false }],
  conflicts: [
    {
      level: 'warning',
      type: 'slot',
      description: 'deploy-bot overlaps with ci-runner on the task-runner slot',
      conflictingPackage: 'ci-runner',
    },
  ],
};

/** Preview with a blocking (error-level) conflict. */
export const MOCK_PERMISSION_PREVIEW_BLOCKING: PermissionPreview = {
  fileChanges: [{ path: '.dork/agents/linear-agent/agent.json', action: 'create' }],
  extensions: [],
  tasks: [],
  secrets: [
    { key: 'LINEAR_API_KEY', required: true, description: 'Linear API key for issue management' },
  ],
  externalHosts: ['api.linear.app'],
  requires: [],
  conflicts: [
    {
      level: 'error',
      type: 'slot',
      description: 'linear-agent conflicts with existing linear-triage (same agent slot)',
      conflictingPackage: 'linear-triage',
    },
    {
      level: 'warning',
      type: 'package-name',
      description: 'Both packages request LINEAR_API_KEY — you will be prompted once',
      conflictingPackage: 'linear-triage',
    },
  ],
};

// ---------------------------------------------------------------------------
// InstalledPackage mocks
// ---------------------------------------------------------------------------

/** Installed packages list for the InstalledPackagesView showcase. */
export const MOCK_INSTALLED_PACKAGES: InstalledPackage[] = [
  {
    name: 'code-reviewer',
    version: '1.4.2',
    type: 'agent',
    installPath: '/Users/kai/.dork/agents/code-reviewer',
    installedFrom: 'https://github.com/dorkos-marketplace/code-reviewer',
    installedAt: '2026-02-14T09:00:00Z',
  },
  {
    name: 'obsidian-sync',
    version: '0.8.1',
    type: 'plugin',
    installPath: '/Users/kai/.dork/plugins/obsidian-sync',
    installedFrom: 'https://github.com/dorkos-marketplace/obsidian-sync',
    installedAt: '2026-03-01T14:30:00Z',
  },
  {
    name: 'python-skills',
    version: '1.0.0',
    type: 'skill-pack',
    installPath: '/Users/kai/.dork/skills/python-skills',
  },
];

// ---------------------------------------------------------------------------
// MarketplaceSource mocks
// ---------------------------------------------------------------------------

/** Configured marketplace sources for the MarketplaceSourcesView showcase. */
export const MOCK_SOURCES: MarketplaceSource[] = [
  {
    name: 'dorkos-official',
    source: 'https://github.com/dorkos-marketplace/registry',
    enabled: true,
    addedAt: '2026-01-10T08:00:00Z',
  },
  {
    name: 'community-registry',
    source: 'https://github.com/community/dorkos-packages',
    enabled: false,
    addedAt: '2026-03-05T12:45:00Z',
  },
];
