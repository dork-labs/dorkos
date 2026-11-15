import { describe, expect, it } from 'vitest';
import { isLooserScheduleMode, scheduleApprovalBaseline } from '../schedule-approval.js';
import {
  isSpecificPermissionRule,
  needsOwnConfirmation,
  readsBroadly,
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

describe('glob patterns in rules (re-review of #3794)', () => {
  it('gives every wildcard file-writing rule, and any .git spelling, its own yes', () => {
    for (const rule of [
      'Edit(**/hooks/pre-commit)',
      'Edit(.gi?/hooks/*)',
      'Write(src/[a-z]*.ts)',
      'Edit(src/{a,b}.ts)',
      'Edit(.GIT/hooks/x)',
      'Edit(.Claude/settings.json)',
    ]) {
      expect(writesOutsideTaskFolder(rule), rule).toBe(true);
      expect(needsOwnConfirmation(rule), rule).toBe(true);
    }
  });

  it('refuses a rule that reaches all of home or a folder above it', () => {
    const home = '/Users/sam';
    for (const rule of [
      'Read(~/?*/**)',
      'Read(//Users/**)',
      'Read(/Users/**)',
      'Read(/**)',
      'Read(/Users/sa?/**)',
      'Read(/Users/sam/[a-z]*/**)',
      'Read(/Users)',
      'Edit(~/{a,b}/**)',
    ]) {
      expect(isSpecificPermissionRule(rule, { home }), rule).toBe(false);
    }
    // ? [ ] { } ! count as wildcards even without a home to compare against.
    expect(isSpecificPermissionRule('Read(~/?*/**)')).toBe(false);
    expect(isSpecificPermissionRule('Read(?/[!]/{}/**)')).toBe(false);
    // A named path under home, or a pattern inside one of its folders, stays.
    expect(isSpecificPermissionRule('Read(//Users/sam/notes/x.md)', { home })).toBe(true);
    expect(isSpecificPermissionRule('Read(/Users/sam/notes/*.md)', { home })).toBe(true);
    expect(isSpecificPermissionRule('Read(notes/**)', { home })).toBe(true);
  });
});

describe('other spellings of the same folder (third review of #3794)', () => {
  const home = '/Users/sam';

  it('refuses home or a parent of it under case, firmlink, volume and step spellings', () => {
    for (const rule of [
      'Read(//users/sam/**)',
      'Read(//USERS/SAM/**)',
      'Read(//System/Volumes/Data/Users/**)',
      'Read(//Volumes/Macintosh HD/Users/**)',
      'Read(//Users/x/../sam/**)',
      'Read(//Users//sam/**)',
      'Read(//Users/sam/notes/*/../../**)',
    ]) {
      expect(isSpecificPermissionRule(rule, { home }), rule).toBe(false);
    }
    expect(isSpecificPermissionRule('Read(//users/sam/notes/x.md)', { home })).toBe(true);
  });

  it('refuses a Windows home and its parents', () => {
    const windows = 'C:\\Users\\sam';
    for (const rule of ['Read(C:\\Users\\**)', 'Read(c:/users/sam/**)', 'Read(~/**)']) {
      expect(isSpecificPermissionRule(rule, { home: windows }), rule).toBe(false);
    }
    expect(isSpecificPermissionRule('Read(C:\\Users\\sam\\notes\\x.md)', { home: windows })).toBe(
      true
    );
  });

  it('gives escaped, backslashed or stepped .git writes their own yes', () => {
    for (const rule of [
      'Edit(.gi\\t/hooks/pre-commit)',
      'Edit(.git\\hooks\\pre-commit)',
      'Edit(a/../.git/hooks/x)',
    ]) {
      expect(writesOutsideTaskFolder(rule), rule).toBe(true);
      expect(needsOwnConfirmation(rule), rule).toBe(true);
    }
  });

  it('gives any pattern over an absolute or home path its own yes, Read included', () => {
    for (const rule of ['Read(//users/sam/notes/**)', 'Read(~/notes/*.md)', 'Read(C:/x/*)']) {
      expect(readsBroadly(rule), rule).toBe(true);
      expect(needsOwnConfirmation(rule), rule).toBe(true);
    }
    expect(needsOwnConfirmation('Read(/Users/sam/notes/x.md)')).toBe(false);
    expect(needsOwnConfirmation('Read(notes/*.md)')).toBe(false);
  });
});
