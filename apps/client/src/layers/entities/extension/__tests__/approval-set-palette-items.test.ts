/**
 * ⌘K's review rows for a plugin's extensions (DOR-3583). Purpose: the row
 * names the plugin and only opens its row in Settings; the action carries no
 * approval of its own.
 */
import { describe, expect, it } from 'vitest';
import {
  REVIEW_EXTENSION_SET_ACTION,
  extensionSetFromAction,
  extensionSetSection,
} from '../model/use-approval-set-palette-items';

describe('palette extension sets', () => {
  it('reads the plugin back from its review action, and nothing else', () => {
    expect(extensionSetFromAction(`${REVIEW_EXTENSION_SET_ACTION}marketing-suite`)).toBe(
      'marketing-suite'
    );
    expect(extensionSetFromAction('openSettings')).toBeNull();
  });

  it('opens the same section the group row answers to', () => {
    expect(extensionSetSection('marketing-suite')).toBe('group:marketing-suite');
  });
});
