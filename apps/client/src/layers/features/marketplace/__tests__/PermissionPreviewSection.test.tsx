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
    tasks: [],
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

    // But the outer container still renders.
    expect(container.firstChild).not.toBeNull();
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
          description: 'Slot sidebar.tabs already has an entry with this id.',
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
