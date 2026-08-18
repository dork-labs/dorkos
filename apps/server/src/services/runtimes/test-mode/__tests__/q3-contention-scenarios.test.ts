import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { StreamEvent } from '@dorkos/shared/types';

// The scenarios read the parse-once server env; a mutable hoisted stand-in lets
// each test pick its own duration/tick/canary without re-importing the module.
const envMock = vi.hoisted(() => ({
  DORKOS_Q3_DURATION_MS: 100,
  DORKOS_Q3_TICK_MS: 10,
  DORKOS_Q3_CANARY_MAP: undefined as string | undefined,
  HOME: undefined as string | undefined,
}));
vi.mock('../../../../env.js', () => ({ env: envMock }));
vi.mock('../../../../lib/dork-home.js', () => ({
  resolveDorkHome: () => '/tmp/q3-test-dork-home',
}));

const { Q3_SCENARIOS, Q3_VOCABULARIES, Q3_VOCABULARY_NAMES, parseCanaryMap, q3ScenarioName } =
  await import('../q3-contention-scenarios.js');
const { interactionGate } = await import('../interaction-gate.js');

/** Drain a scenario generator into its concatenated text and raw events. */
async function drain(name: string): Promise<{ text: string; events: StreamEvent[] }> {
  const scenario = Q3_SCENARIOS[name];
  if (!scenario) throw new Error(`missing scenario ${name}`);
  const events: StreamEvent[] = [];
  let text = '';
  // The q3 scenarios never park on the context and read no turn options, but
  // every ScenarioFn now takes both — a real gate rather than a cast, so this
  // stays honest if one ever does.
  for await (const event of scenario('go', interactionGate.open('q3-drain'), undefined)) {
    events.push(event);
    if (event.type === 'text_delta') text += (event.data as { text: string }).text;
  }
  return { text, events };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'q3-scenario-'));
  envMock.DORKOS_Q3_DURATION_MS = 100;
  envMock.DORKOS_Q3_TICK_MS = 10;
  envMock.DORKOS_Q3_CANARY_MAP = undefined;
  envMock.HOME = undefined;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('q3 vocabularies', () => {
  it('registers one scenario per vocabulary under a q3- name', () => {
    expect(Object.keys(Q3_SCENARIOS).sort()).toEqual(
      Q3_VOCABULARY_NAMES.map(q3ScenarioName).sort()
    );
    expect(Q3_VOCABULARY_NAMES.length).toBeGreaterThanOrEqual(3);
  });

  it('uses token sets that share no word between vocabularies', () => {
    const seen = new Map<string, string>();
    for (const [vocab, words] of Object.entries(Q3_VOCABULARIES)) {
      for (const word of words) {
        const owner = seen.get(word);
        expect(owner, `"${word}" appears in both ${owner} and ${vocab}`).toBeUndefined();
        seen.set(word, vocab);
      }
    }
  });

  it('tags every streamed token with its own vocabulary', async () => {
    const { text } = await drain(q3ScenarioName('cats'));
    const tokens = text.split(/\s+/).filter((t) => /#\d+$/.test(t));
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(token).toMatch(/^cats:[A-Z]+#\d{5}$/);
      const word = token.slice('cats:'.length, token.indexOf('#'));
      expect(Q3_VOCABULARIES.cats as readonly string[]).toContain(word);
    }
  });

  it('emits start and summary markers carrying server-side timestamps', async () => {
    const { text } = await drain(q3ScenarioName('dogs'));
    const start = /\[q3-start] vocab=dogs startedAt=(\d+)/.exec(text);
    const summary =
      /\[q3-summary] vocab=dogs startedAt=(\d+) endedAt=(\d+) ticks=(\d+) appends=(\d+) canaryErrors=(\d+)/.exec(
        text
      );
    expect(start).not.toBeNull();
    expect(summary).not.toBeNull();
    expect(Number(summary![2])).toBeGreaterThanOrEqual(Number(summary![1]));
    expect(Number(summary![3])).toBeGreaterThan(0);
  });

  it('holds the turn open for roughly the configured duration', async () => {
    envMock.DORKOS_Q3_DURATION_MS = 150;
    envMock.DORKOS_Q3_TICK_MS = 10;
    const started = Date.now();
    await drain(q3ScenarioName('birds'));
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });
});

describe('q3 canary read-modify-write', () => {
  it('appends one tagged, counter-stamped line per tick and reports the count', async () => {
    const canary = path.join(tmpDir, 'canary.log');
    envMock.DORKOS_Q3_CANARY_MAP = JSON.stringify({ fish: canary });

    const { text } = await drain(q3ScenarioName('fish'));

    const appends = Number(/appends=(\d+)/.exec(text)![1]);
    const canaryErrors = Number(/canaryErrors=(\d+)/.exec(text)![1]);
    const lines = (await fs.readFile(canary, 'utf8')).trimEnd().split('\n');

    expect(canaryErrors).toBe(0);
    expect(lines).toHaveLength(appends);
    // Uncontended, the counters are dense and start at zero.
    expect(lines.map((l) => Number(l.split(' ')[1]))).toEqual(lines.map((_, i) => i));
    for (const line of lines) expect(line.startsWith('fish ')).toBe(true);
  });

  it('leaves the filesystem alone when no canary is configured', async () => {
    await drain(q3ScenarioName('moths'));
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it('preserves lines written by another vocabulary into the same canary', async () => {
    const canary = path.join(tmpDir, 'shared.log');
    await fs.writeFile(canary, 'dogs 0 seed\n', 'utf8');
    envMock.DORKOS_Q3_CANARY_MAP = JSON.stringify({ frogs: canary });

    await drain(q3ScenarioName('frogs'));

    const content = await fs.readFile(canary, 'utf8');
    expect(content.startsWith('dogs 0 seed\n')).toBe(true);
    expect(content).toContain('frogs 0 ');
  });
});

describe('parseCanaryMap', () => {
  it('returns an empty map when unset', () => {
    expect(parseCanaryMap(undefined, []).size).toBe(0);
  });

  it('resolves configured vocabularies to absolute paths', () => {
    const map = parseCanaryMap(JSON.stringify({ cats: '/tmp/a', dogs: '/tmp/b' }), []);
    expect(map.get('cats')).toBe('/tmp/a');
    expect(map.get('dogs')).toBe('/tmp/b');
  });

  it('rejects a relative path', () => {
    expect(() => parseCanaryMap(JSON.stringify({ cats: 'relative/canary' }), [])).toThrow(
      /must be absolute/
    );
  });

  it('rejects a path inside a protected root', () => {
    expect(() =>
      parseCanaryMap(JSON.stringify({ cats: '/home/me/.dork/canary' }), ['/home/me/.dork'])
    ).toThrow(/protected directory/);
  });

  it('rejects the protected root itself', () => {
    expect(() =>
      parseCanaryMap(JSON.stringify({ cats: '/home/me/.dork' }), ['/home/me/.dork'])
    ).toThrow(/protected directory/);
  });

  it('allows a sibling path that merely shares a prefix', () => {
    const map = parseCanaryMap(JSON.stringify({ cats: '/home/me/.dork-run/canary' }), [
      '/home/me/.dork',
    ]);
    expect(map.get('cats')).toBe('/home/me/.dork-run/canary');
  });

  it('rejects an unknown vocabulary', () => {
    expect(() => parseCanaryMap(JSON.stringify({ lizards: '/tmp/a' }), [])).toThrow(
      /unknown vocabulary/
    );
  });

  it('rejects malformed JSON', () => {
    expect(() => parseCanaryMap('{not json', [])).toThrow(/not valid JSON/);
  });
});
