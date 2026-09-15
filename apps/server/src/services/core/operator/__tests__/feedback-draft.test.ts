/**
 * The `feedback_draft` capability, against a real `ConfigManager` over a real
 * temp data directory (DOR-2056).
 *
 * ## What these are actually asking
 *
 * The defect is an agent that had no way to help. Asked "can you submit feedback
 * or bug reports?", DorkBot found no capability, invented a rule saying it was
 * "not allowed to run the dorkos command", and offered to open a public GitHub
 * issue itself. So there are two claims worth pinning, and neither of them is
 * "the handler returns a string".
 *
 * **One: the link is the link the CLI would have printed.** Not "a link that
 * looks similar". `dorkos feedback --print` and this capability run the same
 * `gatherFeedbackReport` over the same allowlist and the same `buildIssueUrl`,
 * so the two URLs can differ on exactly one line, the one that says where the
 * report came from. That is asserted here line by line rather than assumed from
 * the shared import.
 *
 * The chain is three links and each is pinned where it can be seen:
 * `packages/cli/src/commands/__tests__/feedback.test.ts` pins that `dorkos
 * feedback --print` prints `buildIssueUrl(gatherCliReport(…))` and that
 * `gatherCliReport` is `gatherFeedbackReport` with `surface: 'cli'`;
 * `packages/shared/src/__tests__/feedback.test.ts` pins that two surfaces over
 * one host differ by one line; and this file pins that the capability's URL is
 * the `surface: 'agent'` end of that pair. No single assertion can span the two
 * packages, because the server may not import the CLI.
 *
 * **Two: nothing leaves the machine and nothing is written.** The tier is
 * `observe` on that basis, so `fetch` is stubbed to fail the test if it is ever
 * called, rather than trusted not to be.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildIssueUrl,
  gatherFeedbackReport,
  FEEDBACK_ISSUES_NEW_URL,
} from '@dorkos/shared/feedback';
import type { ConfigManager } from '../../config-manager.js';
import type { OperatorToolResult } from '../operator-tool-handlers.js';
import { SERVER_VERSION } from '../../../../lib/version.js';

/** The config sections these tests write, read straight off the store. */
function snapshot(cm: ConfigManager) {
  return {
    logging: cm.get('logging'),
    runtimes: cm.get('runtimes'),
    tunnel: cm.get('tunnel'),
    mcp: cm.get('mcp'),
    server: cm.get('server'),
  };
}

/** The payload shape `feedback_draft` answers with. */
interface FeedbackDraftPayload {
  url: string;
  kind: string;
  filledFields: string[];
}

describe('the feedback_draft capability', () => {
  let tmpDir: string;
  let configManager: ConfigManager;
  let draft: ReturnType<typeof import('../operator-tool-handlers.js').createFeedbackDraftHandler>;
  /** The five sections these tests write, as the store had them at boot. */
  let pristine: ReturnType<typeof snapshot>;

  // ONE store for the file, not one per test. Building a `ConfigManager` runs
  // every config migration against a fresh directory, which is ~1s of real work
  // on a busy machine; ten of them turned a 10s hook budget into a coin flip
  // under load. Each test restores the sections it writes instead, which is the
  // same isolation for a fraction of the cost. `feedback_draft` writes nothing,
  // so the only mutations to undo are the ones the tests make themselves.
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-feedback-draft-'));
    process.env.DORK_HOME = tmpDir;

    const configModule = await import('../../config-manager.js');
    configManager = configModule.initConfigManager(tmpDir);
    pristine = snapshot(configManager);

    const handlers = await import('../operator-tool-handlers.js');
    draft = handlers.createFeedbackDraftHandler();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    configManager.set('logging', pristine.logging);
    configManager.set('runtimes', pristine.runtimes);
    configManager.set('tunnel', pristine.tunnel);
    configManager.set('mcp', pristine.mcp);
    configManager.set('server', pristine.server);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** The JSON payload the handler answered with, and whether it was an error. */
  async function call(args: Parameters<typeof draft>[0]): Promise<{
    isError: boolean;
    payload: FeedbackDraftPayload;
  }> {
    const result: OperatorToolResult = await draft(args);
    return {
      isError: result.isError === true,
      payload: JSON.parse(result.content[0]!.text) as FeedbackDraftPayload,
    };
  }

  /** The decoded query parts of a prefilled issue URL. */
  function parts(url: string): { title: string; body: string; labels: string } {
    const params = new URL(url).searchParams;
    return {
      title: params.get('title') ?? '',
      body: params.get('body') ?? '',
      labels: params.get('labels') ?? '',
    };
  }

  /** The URL the CLI path builds for this same host and stored config. */
  function cliUrl(kind: 'bug' | 'feature' | 'runtime' = 'bug'): string {
    return buildIssueUrl(
      gatherFeedbackReport({
        kind,
        version: SERVER_VERSION,
        platform: `${process.platform}-${process.arch}`,
        surface: 'cli',
        readConfigValue: (key) => configManager.getDot(key),
      })
    );
  }

  it('builds the link `dorkos feedback --print` prints, off by one line', async () => {
    configManager.set('logging', { ...configManager.get('logging'), level: 'debug' });

    const { isError, payload } = await call({});
    expect(isError).toBe(false);
    expect(payload.url.startsWith(`${FEEDBACK_ISSUES_NEW_URL}?`)).toBe(true);

    const agent = parts(payload.url);
    const cli = parts(cliUrl());

    expect(agent.title).toBe(cli.title);
    expect(agent.labels).toBe(cli.labels);

    const agentLines = agent.body.split('\n');
    const cliLines = cli.body.split('\n');
    expect(agentLines).toHaveLength(cliLines.length);
    expect(
      cliLines.map((line, i) => [line, agentLines[i]] as const).filter(([a, b]) => a !== b)
    ).toEqual([['- Reported from: cli', '- Reported from: agent']]);
  });

  it('reports this host: its version, its platform, its runtimes, its on/off settings', async () => {
    configManager.set('runtimes', {
      ...configManager.get('runtimes'),
      opencode: { ...configManager.get('runtimes').opencode, enabled: false },
    });

    const { payload } = await call({});
    const { body } = parts(payload.url);

    expect(body).toContain(`- DorkOS version: ${SERVER_VERSION}`);
    expect(body).toContain(`- OS / arch: ${process.platform}-${process.arch}`);
    // Scoped to the runtimes LINE: the settings block below it legitimately
    // names `runtimes.opencode.enabled`, so a whole-body check would pass for
    // the wrong reason (or, as written first, fail for it).
    expect(body.split('\n')).toContain('- Runtimes configured: claude-code, codex');
    expect(body).toContain('runtimes.opencode.enabled: false');
  });

  it('defaults to a bug report and labels each kind the way GitHub expects', async () => {
    const fallback = await call({});
    expect(fallback.payload.kind).toBe('bug');
    expect(parts(fallback.payload.url).labels).toBe('bug');
    expect(parts(fallback.payload.url).title).toBe('Bug: (describe what went wrong)');

    expect(parts((await call({ kind: 'feature' })).payload.url).labels).toBe('enhancement');
    expect(parts((await call({ kind: 'runtime' })).payload.url).labels).toBe('bug');
    expect((await call({ kind: 'runtime' })).payload.kind).toBe('runtime');
  });

  it('writes what it was given in place of the blank questions', async () => {
    const { payload } = await call({
      kind: 'bug',
      title: 'Sessions stop streaming after the laptop sleeps',
      body: 'The reply stops mid-sentence and never resumes until I reload.',
    });
    const { title, body } = parts(payload.url);

    expect(title).toBe('Sessions stop streaming after the laptop sleeps');
    expect(body).toContain('The reply stops mid-sentence and never resumes until I reload.');
    expect(body).not.toContain('## What happened?');
    // The environment block still rides underneath what the agent wrote.
    expect(body).toContain(`- DorkOS version: ${SERVER_VERSION}`);
  });

  // DOR-2056 names this one: a token and an absolute path in the written body.
  // Asserted against what `redactSecrets` actually does, not against its
  // docblock's promise.
  it('scrubs a token, a home path and an email out of what the agent wrote', async () => {
    const { payload } = await call({
      kind: 'bug',
      title: 'Crash reported by dorian@dorkian.example',
      body: [
        'I started it with ghp_abc123DEF456ghi789JKL012mno345 and it died.',
        'The stack points at /Users/dorian/Keep/dork-os/dorkos/apps/server/src/index.ts',
        'It also happens against 10.0.0.1.',
      ].join('\n'),
    });
    const { title, body } = parts(payload.url);
    const decoded = `${title}\n${body}`;

    expect(decoded).not.toContain('ghp_abc123DEF456ghi789JKL012mno345');
    expect(decoded).not.toContain('/Users/dorian');
    expect(decoded).not.toContain('dorian@dorkian.example');
    expect(decoded).not.toContain('10.0.0.1');
    // The prose around them survives, or the scrub would have eaten the report.
    expect(decoded).toContain('and it died.');
    expect(decoded).toContain('The stack points at');
  });

  // The guarantee half, as opposed to the defence half above: a config store
  // stuffed with credentials and paths produces a URL naming none of them,
  // because only the allowlist is ever read.
  it('cannot carry a secret or a directory out of config, however the config looks', async () => {
    configManager.set('tunnel', {
      ...configManager.get('tunnel'),
      enabled: true,
      authtoken: 'ngrok-secret-token-value',
    });
    configManager.set('mcp', { ...configManager.get('mcp'), apiKey: 'sk-live-0123456789' });
    configManager.set('server', {
      ...configManager.get('server'),
      boundary: '/Users/dorian/private-clients',
    });

    const { payload } = await call({});
    const { title, body } = parts(payload.url);
    const decoded = `${title}\n${body}`;

    expect(decoded).not.toContain('ngrok-secret-token-value');
    expect(decoded).not.toContain('sk-live-0123456789');
    expect(decoded).not.toContain('private-clients');
    expect(decoded).not.toContain('/Users/dorian');
    // …while the allowlisted on/off value from the same section is reported.
    expect(body).toContain('tunnel.enabled: true');
  });

  it('names the parts it filled in, and claims settings only when there are some', async () => {
    const written = await call({ kind: 'bug', title: 'A title', body: 'A body' });
    expect(written.payload.filledFields).toEqual([
      'title',
      'body',
      'version',
      'platform',
      'runtimes',
      'settings',
    ]);

    const bare = await call({});
    expect(bare.payload.filledFields).toEqual(['version', 'platform', 'runtimes', 'settings']);

    // Whitespace-only writes fall back to the placeholder in the URL, so they
    // must not be claimed here either.
    const blank = await call({ kind: 'bug', title: '   ', body: '\n \n' });
    expect(blank.payload.filledFields).toEqual(['version', 'platform', 'runtimes', 'settings']);
    expect(parts(blank.payload.url).title).toBe('Bug: (describe what went wrong)');
  });

  it('sends nothing: no request leaves the machine', async () => {
    // The tier is `observe` on exactly this basis, so it is checked rather than
    // trusted. A drafting tool that quietly filed the issue would be the worst
    // possible version of this capability.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { isError, payload } = await call({ kind: 'bug', body: 'Something broke.' });

    expect(isError).toBe(false);
    expect(payload.url).toContain('github.com');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('changes nothing in config', async () => {
    const before = JSON.stringify(configManager.get('ui'));
    await call({ kind: 'feature', title: 'Make it faster', body: 'Please.' });
    expect(JSON.stringify(configManager.get('ui'))).toBe(before);
  });
});
