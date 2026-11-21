import { describe, expect, it } from 'vitest';
import {
  CONTRIBUTION_WORDS,
  EXTENSION_CONTRIBUTION_KEYS,
  contributionWords,
  declaredContributions,
  declaresContribution,
  isContributionKey,
  type ExtensionPointId,
} from '../index.js';

describe('contribution slots', () => {
  it('lists every extension point, plus pages, canvas and inbox', () => {
    const points: ExtensionPointId[] = [
      'sidebar.footer',
      'dashboard.sections',
      'command-palette.items',
      'dialog',
      'settings.tabs',
      'right-panel',
      'status-bar',
    ];
    expect([...EXTENSION_CONTRIBUTION_KEYS].sort()).toEqual(
      [...points, 'pages', 'canvas', 'inbox'].sort()
    );
  });

  it('has plain words for every place', () => {
    for (const key of EXTENSION_CONTRIBUTION_KEYS) {
      expect(CONTRIBUTION_WORDS[key]).toMatch(/\S/);
    }
    expect(CONTRIBUTION_WORDS['command-palette.items']).toBe('⌘K commands');
  });

  it('declares a place only when its key is exactly true', () => {
    expect(declaresContribution({ contributions: { pages: true } }, 'pages')).toBe(true);
    expect(declaresContribution({ contributions: { pages: false } }, 'pages')).toBe(false);
    expect(declaresContribution({}, 'pages')).toBe(false);
    expect(declaresContribution(undefined, 'pages')).toBe(false);
    const loose = { contributions: { pages: 'yes' } } as unknown as {
      contributions: Record<string, boolean>;
    };
    expect(declaresContribution(loose, 'pages')).toBe(false);
  });

  it('lists declared places in card order and leaves unknown keys out', () => {
    expect(
      declaredContributions({
        contributions: { inbox: true, 'made-up': true, pages: true, dialog: false },
      })
    ).toEqual(['pages', 'inbox']);
    expect(isContributionKey('made-up')).toBe(false);
  });

  it('puts only DorkOS’s own words on a card', () => {
    expect(contributionWords(['dialog', 'Sign in again', 'pages'])).toEqual(['a page', 'dialogs']);
  });
});
