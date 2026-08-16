/**
 * What a config write is allowed to say about itself in the log (DOR-1237).
 *
 * The line exists because `runtimes.claudeCode.defaultTrustStop` — an
 * operator-only setting — drifted twice on a real install with nothing on disk
 * that could name the writer. So the first thing pinned here is that the line is
 * SPECIFIC enough to answer that: the leaf, not the section it lives in, and
 * derived from what was WRITTEN rather than what was asked for.
 *
 * The other two are what make the line safe to keep at `info` forever, and both
 * are about untrusted input reaching a log:
 *
 * 1. **No values.** Config holds real secrets and logs get pasted into issues.
 *    Asserted against a patch carrying a secret at every sensitive key the
 *    schema declares, so a change that starts logging values fails here.
 * 2. **No forgery.** Three sections are `z.record`s, so their leaf segments are
 *    caller-chosen, and one of them is `agent-writable`. A key holding a newline
 *    and a counterfeit `[Config] Patched: …` line would otherwise write a
 *    perfect fake of the record this feature exists to make trustworthy. The
 *    record sections are read off the schema rather than hand-listed, the way
 *    the secret test is built from `SENSITIVE_CONFIG_KEYS`, so a fourth one is
 *    covered the day it is added.
 */
import { describe, it, expect } from 'vitest';
import { SENSITIVE_CONFIG_KEYS } from '@dorkos/shared/config-schema';
import { describeConfigWrite } from '../config-patch.js';
import { configSchemaLeaves } from '../config-disclosure.js';

/** Build the nested object that puts `leaf` at `dotPath`. */
function at(dotPath: string, leaf: unknown): Record<string, unknown> {
  const keys = dotPath.split('.');
  let node: unknown = leaf;
  for (const key of keys.reverse()) node = { [key]: node };
  return node as Record<string, unknown>;
}

/** ESC, the character that starts an ANSI sequence. */
const ESC = String.fromCharCode(0x1b);

describe('a write names the leaves it changed', () => {
  it('names the leaf, not the section it lives under', () => {
    // The whole point: `runtimes` would not have answered DOR-1237's question.
    expect(
      describeConfigWrite(
        at('runtimes.claudeCode.defaultTrustStop', 'autonomy'),
        at('runtimes.claudeCode.defaultTrustStop', 'act')
      )
    ).toBe('runtimes.claudeCode.defaultTrustStop');
  });

  it('names a leaf set to null — clearing a setting is a write', () => {
    // The Reset demotion writes exactly this shape. A summary that skipped
    // nulls would go quiet on the one write nobody asked for.
    expect(
      describeConfigWrite(
        at('ui.autonomyAcknowledgedAt', '2026-08-01T09:30:00.000Z'),
        at('ui.autonomyAcknowledgedAt', null)
      )
    ).toBe('ui.autonomyAcknowledgedAt');
  });

  it('names a leaf that appeared, and one that went away', () => {
    expect(describeConfigWrite({ ui: {} }, at('ui.theme', 'dark'))).toBe('ui.theme');
    expect(describeConfigWrite(at('ui.theme', 'dark'), { ui: {} })).toBe('ui.theme');
  });

  it('says nothing about a request that changed nothing', () => {
    // A no-op PATCH is the common case for a client that re-sends its whole
    // section. Reporting it would fill the log with writes that never happened.
    const stored = at('ui.theme', 'dark');
    expect(describeConfigWrite(stored, at('ui.theme', 'dark'))).toBe('');
    expect(describeConfigWrite({}, {})).toBe('');
    expect(describeConfigWrite(null, {})).toBe('');
    expect(describeConfigWrite(stored, 'not-a-config')).toBe('');
  });

  it('compares arrays in order, because reordering is a change somebody made', () => {
    const before = at('ui.statusBar.pins', ['cwd', 'git']);
    expect(describeConfigWrite(before, at('ui.statusBar.pins', ['git', 'cwd']))).toBe(
      'ui.statusBar.pins'
    );
    expect(describeConfigWrite(before, at('ui.statusBar.pins', ['cwd', 'git']))).toBe('');
  });
});

describe('the order protects the settings worth protecting', () => {
  it('names every operator-only leaf before anything else', () => {
    // The cap must never be what hides a security setting, so ordering — not
    // the cap's size — is what guarantees it survives. `ui.theme` sorts before
    // `runtimes.…` alphabetically; the operator-only one still comes first.
    const before = { ui: { theme: 'light' }, runtimes: { defaultTrustStop: 'ask' } };
    const after = { ui: { theme: 'dark' }, runtimes: { defaultTrustStop: 'autonomy' } };

    expect(describeConfigWrite(before, after)).toBe('runtimes.defaultTrustStop, ui.theme');
  });

  it('sorts within each group, so the same write always reads the same way', () => {
    const before = { ui: { theme: 'light', composer: { richText: true } } };
    const after = { ui: { theme: 'dark', composer: { richText: false } } };

    expect(describeConfigWrite(before, after)).toBe('ui.composer.richText, ui.theme');
  });

  it('stops at eight and counts the rest, with the operator-only leaf kept', () => {
    const before = { telemetry: {}, runtimes: { defaultTrustStop: 'ask' } };
    const after = {
      telemetry: Object.fromEntries([...Array(11)].map((_, i) => [`k${i}`, i])),
      runtimes: { defaultTrustStop: 'autonomy' },
    };

    const line = describeConfigWrite(before, after);

    expect(line.startsWith('runtimes.defaultTrustStop, ')).toBe(true);
    expect(line.endsWith(', and 4 more')).toBe(true);
    expect(line.split(', ')).toHaveLength(9);
  });
});

describe('a value never reaches the log', () => {
  it('withholds every secret the schema declares sensitive', () => {
    // Built from `SENSITIVE_CONFIG_KEYS` rather than a hand-written list, so a
    // key added there is covered here without anyone remembering to.
    const secrets = SENSITIVE_CONFIG_KEYS.map((key, i) => `s3cret-${i}-${key}`);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    SENSITIVE_CONFIG_KEYS.forEach((key, i) => {
      const [section, leaf] = key.split('.') as [string, string];
      before[section] = { ...((before[section] as object) ?? {}), [leaf]: null };
      after[section] = { ...((after[section] as object) ?? {}), [leaf]: secrets[i] };
    });

    const line = describeConfigWrite(before, after);

    for (const key of SENSITIVE_CONFIG_KEYS) expect(line).toContain(key);
    for (const secret of secrets) expect(line).not.toContain(secret);
  });

  it('withholds an array’s contents — an array is a leaf, not a road', () => {
    const line = describeConfigWrite(
      at('runtimes.claudeCode.accounts', []),
      at('runtimes.claudeCode.accounts', [{ path: '/Users/someone/.claude', label: 'work' }])
    );

    expect(line).toBe('runtimes.claudeCode.accounts');
    expect(line).not.toContain('someone');
    expect(line).not.toContain('work');
  });

  it('withholds a string, number and boolean alike', () => {
    const line = describeConfigWrite(
      { server: { port: 4242, cwd: null }, auth: { enabled: false } },
      { server: { port: 8080, cwd: '/Users/someone/secret-project' }, auth: { enabled: true } }
    );

    expect(line).toContain('server.cwd');
    expect(line).toContain('server.port');
    expect(line).toContain('auth.enabled');
    expect(line).not.toContain('8080');
    expect(line).not.toContain('secret-project');
  });
});

describe('a caller-chosen key cannot forge a log line', () => {
  /**
   * The record-shaped sections, read off the schema itself.
   *
   * Hand-listing them is how this test would rot: a fourth `z.record` added
   * next year would be the one hole nobody checked. Two reviews disagreed about
   * how many there are and what they are called, which is the argument for
   * asking the schema instead of either of them.
   */
  const recordSections = configSchemaLeaves()
    .filter((leaf) => leaf.shape === 'record')
    .map((leaf) => leaf.path);

  it('finds the record sections it is supposed to cover', () => {
    // A guard on the guard: if the shape classification ever stops reporting
    // records, every case below would pass by testing nothing.
    expect(recordSections.length).toBeGreaterThan(0);
  });

  it.each(recordSections)('neutralizes a forged line under %s', (section) => {
    // The exact payload reproduced against the real route during review: a key
    // that closes the current line and opens a counterfeit one naming the very
    // setting this feature exists to make auditable.
    const forged = `proj\n[info] [Config] Patched: runtimes.claudeCode.defaultTrustStop`;

    const line = describeConfigWrite(at(section, {}), at(section, { [forged]: 'x' }));

    expect(line).not.toBe('');
    // One line. Nothing downstream can be made to read a second one.
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    expect(line.split('\n')).toHaveLength(1);
    // Neutralized, not dropped: the key is still reported, escaped, so the line
    // stays a truthful record of what was written.
    expect(line).toContain('\\n');
    expect(line).toContain(section);
  });

  it.each(recordSections)('neutralizes an ANSI escape under %s', (section) => {
    const line = describeConfigWrite(
      at(section, {}),
      at(section, { [`${ESC}[31mred${ESC}[0m`]: 'x' })
    );

    expect(line).not.toContain(ESC);
    expect(line).toContain('\\u001b');
  });

  it('clips a key long enough to swamp the log', () => {
    const line = describeConfigWrite(
      at('ui.shapes.agentDefaults', {}),
      at('ui.shapes.agentDefaults', { ['x'.repeat(5000)]: 'y' })
    );

    expect(line.length).toBeLessThan(200);
    expect(line).toContain('…');
  });

  it('leaves an ordinary key readable', () => {
    // Escaping must not cost legibility on the everyday case, or nobody reads
    // the log. A plain key passes through bare; one with a space is quoted.
    expect(
      describeConfigWrite(
        at('ui.shapes.agentDefaults', {}),
        at('ui.shapes.agentDefaults', { dorkbot: 'a' })
      )
    ).toBe('ui.shapes.agentDefaults.dorkbot');
    expect(
      describeConfigWrite(
        at('ui.shapes.agentDefaults', {}),
        at('ui.shapes.agentDefaults', { 'my agent': 'a' })
      )
    ).toBe('ui.shapes.agentDefaults."my agent"');
  });
});
