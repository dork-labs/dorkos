// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SmartGroupRuleDialog } from '../ui/SmartGroupRuleDialog';

beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => cleanup());

const RUNTIME_OPTIONS = [
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
];

describe('SmartGroupRuleDialog', () => {
  describe('create mode', () => {
    it('disables Create until both a name and at least one rule are set', () => {
      render(
        <SmartGroupRuleDialog
          open
          onOpenChange={() => {}}
          mode="create"
          runtimeOptions={RUNTIME_OPTIONS}
          namespaceOptions={[]}
          onSubmit={() => {}}
        />
      );
      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My group' } });
      // Name alone isn't enough — the schema requires >= 1 rule constraint.
      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

      fireEvent.click(screen.getByRole('checkbox', { name: 'Codex' }));
      expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
    });

    it('submits the trimmed name and the exact rules built from the form, then closes', () => {
      const onSubmit = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <SmartGroupRuleDialog
          open
          onOpenChange={onOpenChange}
          mode="create"
          runtimeOptions={RUNTIME_OPTIONS}
          namespaceOptions={[]}
          onSubmit={onSubmit}
        />
      );
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Codex fleet  ' } });
      fireEvent.click(screen.getByRole('checkbox', { name: 'Codex' }));
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Codex fleet',
        rules: { runtimes: ['codex'] },
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('combines multiple field types into one rules object', () => {
      const onSubmit = vi.fn();
      render(
        <SmartGroupRuleDialog
          open
          onOpenChange={() => {}}
          mode="create"
          runtimeOptions={RUNTIME_OPTIONS}
          namespaceOptions={[]}
          onSubmit={onSubmit}
        />
      );
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Both' } });
      fireEvent.click(screen.getByRole('checkbox', { name: 'Codex' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'active' }));
      fireEvent.change(screen.getByLabelText('Path starts with'), {
        target: { value: '/Users/dorian/work' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Both',
        rules: {
          runtimes: ['codex'],
          statuses: ['active'],
          pathPrefix: '/Users/dorian/work',
        },
      });
    });

    it('shows a live plain-language preview as rules are set', () => {
      render(
        <SmartGroupRuleDialog
          open
          onOpenChange={() => {}}
          mode="create"
          runtimeOptions={RUNTIME_OPTIONS}
          namespaceOptions={[]}
          onSubmit={() => {}}
        />
      );
      expect(screen.getByText('Set at least one rule to preview matches.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Codex' }));
      // "Codex" now appears twice — the checkbox label and the live preview.
      expect(screen.getAllByText('Codex')).toHaveLength(2);
      expect(
        screen.queryByText('Set at least one rule to preview matches.')
      ).not.toBeInTheDocument();
    });

    it('Cancel closes without submitting', () => {
      const onSubmit = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <SmartGroupRuleDialog
          open
          onOpenChange={onOpenChange}
          mode="create"
          runtimeOptions={RUNTIME_OPTIONS}
          namespaceOptions={[]}
          onSubmit={onSubmit}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('shows a namespace checkbox set only when more than one namespace exists', () => {
      render(
        <SmartGroupRuleDialog
          open
          onOpenChange={() => {}}
          mode="create"
          runtimeOptions={[]}
          namespaceOptions={['team-a', 'team-b']}
          onSubmit={() => {}}
        />
      );
      expect(screen.getByText('team-a')).toBeInTheDocument();
      expect(screen.getByText('team-b')).toBeInTheDocument();
      cleanup();
      render(
        <SmartGroupRuleDialog
          open
          onOpenChange={() => {}}
          mode="create"
          runtimeOptions={[]}
          namespaceOptions={['team-a']}
          onSubmit={() => {}}
        />
      );
      expect(screen.queryByText('team-a')).not.toBeInTheDocument();
    });
  });

  describe('edit mode', () => {
    it('shows no Name field and pre-checks the initial rules', () => {
      render(
        <SmartGroupRuleDialog
          open
          onOpenChange={() => {}}
          mode="edit"
          initialName="Active now"
          initialRules={{ runtimes: ['codex'] }}
          runtimeOptions={RUNTIME_OPTIONS}
          namespaceOptions={[]}
          onSubmit={() => {}}
        />
      );
      expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Codex' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'OpenCode' })).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('Save submits the empty-string name (rename lives elsewhere) with the edited rules', () => {
      const onSubmit = vi.fn();
      render(
        <SmartGroupRuleDialog
          open
          onOpenChange={() => {}}
          mode="edit"
          initialName="Active now"
          initialRules={{ runtimes: ['codex'] }}
          runtimeOptions={RUNTIME_OPTIONS}
          namespaceOptions={[]}
          onSubmit={onSubmit}
        />
      );
      fireEvent.click(screen.getByRole('checkbox', { name: 'OpenCode' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Active now',
        rules: { runtimes: ['codex', 'opencode'] },
      });
    });

    it('disables Save when every rule is removed (empty rules would fail the schema)', () => {
      render(
        <SmartGroupRuleDialog
          open
          onOpenChange={() => {}}
          mode="edit"
          initialName="Active now"
          initialRules={{ runtimes: ['codex'] }}
          runtimeOptions={RUNTIME_OPTIONS}
          namespaceOptions={[]}
          onSubmit={() => {}}
        />
      );
      fireEvent.click(screen.getByRole('checkbox', { name: 'Codex' })); // unchecks it
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });
});
