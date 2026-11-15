import { describe, expect, it } from 'vitest';
import { isLooserScheduleMode, scheduleApprovalBaseline } from '../schedule-approval.js';
import {
  isSpecificPermissionRule,
  needsOwnConfirmation,
  writesOutsideTaskFolder,
} from '../permission-rules.js';

describe('scheduleApprovalBaseline', () => {
  it('lets a request narrow the saved mode but never widen it', () => {
    expect(
      scheduleApprovalBaseline({
        permissionMode: 'acceptEdits',
        requestedPermissionMode: 'dontAsk',
      })
    ).toBe('dontAsk');
    expect(
      scheduleApprovalBaseline({
        permissionMode: 'acceptEdits',
        requestedPermissionMode: 'bypassPermissions',
      })
    ).toBe('acceptEdits');
  });

  it('holds outsider work to Allowed commands, or to a tighter request', () => {
    expect(
      scheduleApprovalBaseline({ permissionMode: 'acceptEdits', originMarks: { outsider: true } })
    ).toBe('dontAsk');
    expect(
      scheduleApprovalBaseline({
        permissionMode: 'acceptEdits',
        requestedPermissionMode: 'plan',
        originMarks: { outsider: true },
      })
    ).toBe('plan');
  });

  it('reads an unknown mode as loosest when new and strictest when old', () => {
    expect(isLooserScheduleMode('workspace-write', 'plan')).toBe(true);
    expect(isLooserScheduleMode('plan', 'workspace-write')).toBe(true);
    expect(isLooserScheduleMode('default', 'dontAsk')).toBe(false);
  });
});

describe('permission rules beyond the shape check', () => {
  it('refuses the home folder by its absolute path when the caller names it', () => {
    expect(isSpecificPermissionRule('Read(/Users/sam/**)')).toBe(true);
    expect(isSpecificPermissionRule('Read(/Users/sam/**)', { home: '/Users/sam' })).toBe(false);
    expect(isSpecificPermissionRule('Read(/Users/sam)', { home: '/Users/sam/' })).toBe(false);
    expect(
      isSpecificPermissionRule('Bash(/Users/sam/bin/sweep.sh --once)', { home: '/Users/sam' })
    ).toBe(true);
    expect(isSpecificPermissionRule('Read(/Users/samantha/**)', { home: '/Users/sam' })).toBe(true);
  });

  it('marks file-writing rules outside the task folder for their own yes', () => {
    for (const rule of [
      'Edit(~/.zshrc)',
      'Write(/etc/hosts)',
      'Edit(../other/file.ts)',
      'Edit(.git/hooks/pre-commit)',
      'MultiEdit(.claude/settings.json)',
    ]) {
      expect(writesOutsideTaskFolder(rule), rule).toBe(true);
      expect(needsOwnConfirmation(rule), rule).toBe(true);
    }
    expect(writesOutsideTaskFolder('Edit(notes/today.md)')).toBe(false);
    expect(writesOutsideTaskFolder('Read(/etc/hosts)')).toBe(false);
    expect(needsOwnConfirmation('Bash(/abs/sweep.sh --once)')).toBe(true);
  });
});
