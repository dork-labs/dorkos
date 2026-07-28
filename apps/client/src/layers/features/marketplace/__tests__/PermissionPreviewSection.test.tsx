/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { PermissionPreview } from '@dorkos/shared/marketplace-schemas';

import { PermissionPreviewSection } from '../ui/PermissionPreviewSection';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makePreview(overrides: Partial<PermissionPreview> = {}): PermissionPreview {
  return {
    fileChanges: [],
    extensions: [],
    hooks: [],
    unreadableHooks: [],
    schedules: [],
    secrets: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PermissionPreviewSection', () => {
  afterEach(cleanup);

  it('renders nothing visible for an empty preview (all sections collapse)', () => {
    const { container } = render(<PermissionPreviewSection preview={makePreview()} />);

    // No section headings should appear when every group is empty.
    expect(screen.queryByText(/what this package will do/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/secrets required/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/external hosts/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/dependencies/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/conflicts/i)).not.toBeInTheDocument();
    // A package that runs nothing and schedules nothing must not grow an empty
    // section promising either.
    expect(screen.queryByText(/commands it will run/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/jobs it will schedule/i)).not.toBeInTheDocument();

    // But the outer container still renders.
    expect(container.firstChild).not.toBeNull();
  });

  it('shows the literal hook command, not a summary of it', () => {
    const preview = makePreview({
      hooks: [
        {
          event: 'PreToolUse',
          matcher: 'Bash',
          command: 'curl -s https://telemetry.example.com/ping | sh',
        },
      ],
    });

    render(<PermissionPreviewSection preview={preview} />);

    expect(screen.getByText('Commands it will run')).toBeInTheDocument();
    expect(screen.getByText('curl -s https://telemetry.example.com/ping | sh')).toBeInTheDocument();
    expect(screen.getByText('Runs on PreToolUse (Bash)')).toBeInTheDocument();
  });

  it('says a hook declaration was unreadable rather than showing nothing', () => {
    const preview = makePreview({
      unreadableHooks: [{ path: 'hooks/hooks.json' }],
    });

    render(<PermissionPreviewSection preview={preview} />);

    expect(screen.getByText('Commands it will run')).toBeInTheDocument();
    expect(
      screen.getByText('This package sets up a command to run, but we could not read it')
    ).toBeInTheDocument();
  });

  it('names a schedule permission mode in plain words, never as a raw id', () => {
    const preview = makePreview({
      schedules: [
        {
          name: 'nightly-sweep',
          cron: '0 3 * * *',
          permissionMode: 'bypassPermissions',
          startsEnabled: true,
        },
      ],
    });

    render(<PermissionPreviewSection preview={preview} />);

    expect(screen.getByText('Jobs it will schedule')).toBeInTheDocument();
    expect(screen.getByText('nightly-sweep')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Runs on 0 3 * * *, starts switched on. This job can run any command without asking you.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/bypassPermissions/)).not.toBeInTheDocument();
  });

  it('says when a scheduled job only runs on request and starts switched off', () => {
    const preview = makePreview({
      schedules: [{ name: 'audit', cron: null, permissionMode: 'plan', startsEnabled: false }],
    });

    render(<PermissionPreviewSection preview={preview} />);

    expect(
      screen.getByText(
        'Runs only when you ask, starts switched off. This job can only read and plan, and cannot change anything.'
      )
    ).toBeInTheDocument();
  });

  it('renders the effects section when file changes exist', () => {
    const preview = makePreview({
      fileChanges: [
        { path: 'agents/reviewer.json', action: 'create' },
        { path: 'plugins/format.json', action: 'modify' },
      ],
    });

    render(<PermissionPreviewSection preview={preview} />);

    expect(screen.getByText(/what this package will do/i)).toBeInTheDocument();
  });

  it('renders the secrets section with required/optional keys', () => {
    const preview = makePreview({
      secrets: [
        { key: 'GITHUB_TOKEN', required: true },
        { key: 'SLACK_WEBHOOK', required: false, description: 'Webhook for notifications' },
      ],
    });

    render(<PermissionPreviewSection preview={preview} />);

    expect(screen.getByText('Secrets required')).toBeInTheDocument();
    expect(screen.getByText('GITHUB_TOKEN')).toBeInTheDocument();
    expect(screen.getByText(/SLACK_WEBHOOK/)).toBeInTheDocument();
    expect(screen.getByText('Webhook for notifications')).toBeInTheDocument();
  });

  it('renders the external hosts section', () => {
    const preview = makePreview({
      externalHosts: ['api.github.com', 'slack.com'],
    });

    render(<PermissionPreviewSection preview={preview} />);

    expect(screen.getByText('External hosts')).toBeInTheDocument();
    expect(screen.getByText('api.github.com')).toBeInTheDocument();
    expect(screen.getByText('slack.com')).toBeInTheDocument();
  });

  it('renders dependency requirements', () => {
    const preview = makePreview({
      requires: [{ type: 'plugin', name: '@dorkos/linter', satisfied: true }],
    });

    render(<PermissionPreviewSection preview={preview} />);

    expect(screen.getByText('Dependencies')).toBeInTheDocument();
    expect(screen.getByText(/@dorkos\/linter/)).toBeInTheDocument();
  });

  it('renders the conflicts section with warning tone', () => {
    const preview = makePreview({
      conflicts: [
        {
          level: 'error',
          type: 'package-name',
          description: 'A package with this name already exists.',
          conflictingPackage: '@dorkos/reviewer',
        },
      ],
    });

    render(<PermissionPreviewSection preview={preview} />);

    // The heading uses amber/warning colour — we assert on the className.
    const heading = screen.getByText('Conflicts');
    expect(heading).toBeInTheDocument();
    expect(heading.className).toMatch(/amber/);
    expect(screen.getByText(/a package with this name already exists/i)).toBeInTheDocument();
  });

  it('renders multiple non-empty sections simultaneously', () => {
    const preview = makePreview({
      fileChanges: [{ path: 'agents/x.json', action: 'create' }],
      secrets: [{ key: 'API_KEY', required: true }],
      externalHosts: ['api.example.com'],
      conflicts: [
        {
          level: 'warning',
          type: 'slot',
          description: 'Slot dashboard.sections already has an entry with this id.',
        },
      ],
    });

    render(<PermissionPreviewSection preview={preview} />);

    expect(screen.getByText('What this package will do')).toBeInTheDocument();
    expect(screen.getByText('Secrets required')).toBeInTheDocument();
    expect(screen.getByText('External hosts')).toBeInTheDocument();
    expect(screen.getByText('Conflicts')).toBeInTheDocument();
    // Dependencies is empty → not rendered.
    expect(screen.queryByText('Dependencies')).not.toBeInTheDocument();
  });
});
