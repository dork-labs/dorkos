/**
 * DOR-4315: a scheduled task's own allow list holds exact commands only. Made-up
 * paths throughout; nothing here touches a real file.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_TASK_ALLOW_ENTRIES,
  allowListChange,
  judgeTaskAllowEntry,
  judgeTaskAllowList,
} from '../task-allow-list.js';

const CHECK = 'Bash(/usr/bin/shasum -a 256 -c /home/sample/reviews/sample-backfill.sha256)';
const RUN = 'Bash(/home/sample/agents/media/bin/derive-sample --backfill)';
const VERIFY = 'Bash(/home/sample/agents/media/bin/derive-sample --check)';

describe('judgeTaskAllowEntry', () => {
  it.each([CHECK, RUN, VERIFY, 'Bash(/bin/date)'])('keeps an exact command: %s', (entry) => {
    expect(judgeTaskAllowEntry(entry)).toEqual({ ok: true, rule: entry });
  });

  it('trims the edges and nothing else', () => {
    expect(judgeTaskAllowEntry(`  ${RUN} `)).toEqual({ ok: true, rule: RUN });
  });

  it.each([
    ['Bash', 'not-a-command'],
    ['Bash()', 'not-a-command'],
    ['Read(/home/sample/notes.md)', 'not-a-command'],
    ['mcp__sample__tool', 'not-a-command'],
    ['Bash(*)', 'wildcard'],
    ['Bash(/home/sample/bin/:*)', 'wildcard'],
    ['Bash(/home/sample/bin/derive-sample *)', 'wildcard'],
    ['Bash(/home/sample/bin/derive-?ample)', 'wildcard'],
    ['Bash(/home/sample/bin/[a]b)', 'wildcard'],
    ['Bash(/home/sample/bin/{a,b})', 'wildcard'],
    ['Bash(derive-sample --backfill)', 'not-absolute'],
    ['Bash(./bin/derive-sample)', 'not-absolute'],
    ['Bash(~/bin/derive-sample)', 'not-absolute'],
    ['Bash(/home/sample/../evil/run)', 'outside-path'],
    ['Bash(/bin/cat /home/sample/../secret)', 'outside-path'],
    ['Bash(/bin/date; /bin/rm -rf /home/sample)', 'shell-character'],
    ['Bash(/bin/date && /bin/true)', 'shell-character'],
    ['Bash(/bin/date | /bin/cat)', 'shell-character'],
    ['Bash(/bin/echo $HOME)', 'shell-character'],
    ['Bash(/bin/echo `id`)', 'shell-character'],
    ['Bash(/bin/date > /tmp/sample)', 'shell-character'],
    ['Bash(/bin/cat < /tmp/sample)', 'shell-character'],
    ["Bash(/bin/echo 'quoted')", 'shell-character'],
    ['Bash(/bin/echo "quoted")', 'shell-character'],
    ['Bash(/bin/echo a\\ b)', 'shell-character'],
    ['Bash(/bin/echo (sub))', 'shell-character'],
    ['Bash(/bin/date  --utc)', 'malformed'],
    ['Bash(/bin/date\t--utc)', 'malformed'],
    ['Bash(/bin/date‮)', 'malformed'],
    ['Bash(/bin/date --utc)', 'malformed'],
    ['Bash(/bin/date --utc)', 'malformed'],
    [`Bash(/bin/${'x'.repeat(200)})`, 'malformed'],
    [42, 'malformed'],
  ])('refuses %j (%s)', (entry, reason) => {
    expect(judgeTaskAllowEntry(entry)).toEqual({ ok: false, reason });
  });
});

describe('judgeTaskAllowList', () => {
  it('keeps an exact list, in order, without repeats', () => {
    expect(judgeTaskAllowList([CHECK, RUN, VERIFY, RUN])).toEqual({
      ok: true,
      rules: [CHECK, RUN, VERIFY],
    });
  });

  it('refuses the whole list when one entry is not exact, naming every bad one', () => {
    expect(judgeTaskAllowList([CHECK, 'Bash', 'Bash(*)'])).toEqual({
      ok: false,
      refused: [
        { rule: 'Bash', reason: 'not-a-command' },
        { rule: 'Bash(*)', reason: 'wildcard' },
      ],
    });
  });

  it('refuses a list longer than the cap', () => {
    const many = Array.from(
      { length: MAX_TASK_ALLOW_ENTRIES + 1 },
      (_, i) => `Bash(/bin/sample-${i})`
    );
    expect(judgeTaskAllowList(many)).toMatchObject({ ok: false });
  });

  it('refuses something that is not a list', () => {
    expect(judgeTaskAllowList('Bash(/bin/date)')).toMatchObject({ ok: false });
  });
});

describe('allowListChange', () => {
  it('names what was added and removed', () => {
    expect(allowListChange([CHECK, RUN], [RUN, VERIFY])).toEqual({
      added: [VERIFY],
      removed: [CHECK],
    });
  });

  it('is empty for the same list in another order', () => {
    expect(allowListChange([CHECK, RUN], [RUN, CHECK])).toEqual({ added: [], removed: [] });
  });
});

describe('interpreters', () => {
  // An exact line that starts a shell or runtime runs a script nobody pinned.
  it.each([
    'Bash(/bin/bash /home/sample/bin/derive-sample)',
    'Bash(/bin/sh /home/sample/bin/run)',
    'Bash(/usr/bin/env /home/sample/bin/run)',
    'Bash(/usr/local/bin/python3.12 /home/sample/bin/run.py)',
    'Bash(/usr/local/bin/node /home/sample/bin/run.js)',
    'Bash(/usr/bin/sudo /bin/date)',
    'Bash(/usr/bin/xargs /bin/rm)',
    'Bash(/usr/bin/timeout 60 /home/sample/bin/run)',
    'Bash(/usr/bin/nohup /home/sample/bin/run)',
    'Bash(/usr/bin/git -C /home/sample/repo status)',
    'Bash(/usr/bin/awk -f /home/sample/bin/run.awk)',
    'Bash(/usr/bin/make -C /home/sample/repo)',
  ])('refuses %s', (entry) => {
    expect(judgeTaskAllowEntry(entry)).toEqual({ ok: false, reason: 'interpreter' });
  });
});
