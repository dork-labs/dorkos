/**
 * @vitest-environment node
 *
 * `POST /packages/:name/install`: what an install is held to, when an agent's
 * install needs a person's card (DOR-2306, DOR-2325), the tier gate on the
 * mutation routes (DOR-467), and how refusals come back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConflictError,
  DisclosureChangedError,
  InvalidPackageError,
} from '../../../services/marketplace/installer/errors.js';
import {
  UNSUPPORTED_GIT_REMOTE_MESSAGE,
  UnsupportedSourceUrlError,
} from '../../../services/marketplace/sources/source-url-policy.js';
import { SHAPE_PROJECT_PATH_IGNORED_WARNING } from '../../../services/marketplace/flows/install-shape.js';
import type { DisclosedEffects } from '../../../services/marketplace/preview/disclosed-effects.js';
import {
  buildEmptyPermissionPreview,
  buildSampleInstallResult,
  buildSamplePluginManifest,
  runs,
  tempDir,
  uninstallResult,
  useMarketplaceRoutes,
  writePackageManifest,
} from './marketplace.fixtures.js';

const h = useMarketplaceRoutes();

/** What the dialog was shown the package runs. */
const shownDisclosure = runs('echo hi');

const install = (body: object = {}, name = 'sample-plugin') =>
  h.post(`/packages/${name}/install`, body);

/** A project folder inside the boundary. */
const project = () => {
  const dir = join(h.dorkHome, 'project');
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe('POST /packages/:name/install', () => {
  it('holds the install to what the person was shown, and settles it with that, after it landed', async () => {
    // The installer compares its own resolve against the disclosure; consent
    // records it only for an installed copy that is what the person saw
    // (DOR-2306), and before the refresh reads it.
    h.installer.install.mockResolvedValue(buildSampleInstallResult());

    const res = await install({
      approvedDisclosure: shownDisclosure,
      approvedContentHash: 'sha256:seen',
    });

    expect(res.status).toBe(200);
    expect(h.installer.install.mock.calls[0][0].approvedDisclosure).toEqual(shownDisclosure);
    expect(h.installer.install.mock.calls[0][0]).not.toHaveProperty('approvedContentHash');
    expect(h.consent.settle).toHaveBeenCalledWith(
      expect.objectContaining({ global: true, type: 'plugin' }),
      { disclosed: shownDisclosure, contentHash: 'sha256:seen' }
    );
    expect(h.consent.settle.mock.invocationCallOrder[0]).toBeLessThan(
      h.onPluginsChanged.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('settles with no approval when the person sent no disclosure (an older client)', async () => {
    h.installer.install.mockResolvedValue(buildSampleInstallResult());
    await install();
    expect(h.consent.settle).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('returns the InstallResult, and refreshes the global scope', async () => {
    h.installer.install.mockResolvedValue(buildSampleInstallResult());

    const res = await install({ marketplace: 'dorkos-community', force: false });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, packageName: 'sample-plugin' });
    expect(h.installer.install.mock.calls[0][0]).toEqual({
      name: 'sample-plugin',
      marketplace: 'dorkos-community',
      force: false,
    });
    expect(h.onPluginsChanged.mock.calls).toEqual([
      [{ projectPath: undefined, packageName: 'sample-plugin', action: 'install' }],
    ]);
  });

  it('installs into the canonical projectPath (DOR-711) and refreshes the resolved manifest name (DOR-264)', async () => {
    // One directory reached by two spellings must be one install target; and
    // a raw path param (`dorkos install ./local/path`) must not reach Harness
    // Sync, which would look under `.dork/plugins/<raw-path>` and find nothing.
    h.installer.install.mockResolvedValue(buildSampleInstallResult());
    const real = project();
    const link = join(h.dorkHome, 'link-to-project');
    symlinkSync(real, link);

    await install({ projectPath: link }, encodeURIComponent('./local/clones/sample-plugin'));

    expect(h.installer.install.mock.calls[0][0]).toMatchObject({ projectPath: real });
    expect(h.onPluginsChanged.mock.calls).toEqual([
      [{ projectPath: link, packageName: 'sample-plugin', action: 'install' }],
    ]);
  });

  it('surfaces warnings from installer.install verbatim (DOR-386)', async () => {
    h.installer.install.mockResolvedValue({
      ...buildSampleInstallResult(),
      type: 'shape' as const,
      warnings: [SHAPE_PROJECT_PATH_IGNORED_WARNING],
    });

    const res = await install({ projectPath: project() }, 'linear-ops');

    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([SHAPE_PROJECT_PATH_IGNORED_WARNING]);
  });

  it('answers 409 disclosure_changed when the package now runs something else', async () => {
    h.installer.install.mockRejectedValue(
      new DisclosureChangedError('1 shell command ("echo hi")', '1 shell command ("curl | sh")')
    );

    const res = await install({ approvedDisclosure: shownDisclosure });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('disclosure_changed');
    expect(h.consent.settle).not.toHaveBeenCalled();
    expect(h.onPluginsChanged).not.toHaveBeenCalled();
  });

  it('refuses a disclosure that is not the right shape', async () => {
    const res = await install({ approvedDisclosure: { hooks: 'everything' } });
    expect(res.status).toBe(400);
    expect(h.installer.install).not.toHaveBeenCalled();
  });

  it('returns 400 and the refusal sentence when the address is not one we install from (DOR-1799)', async () => {
    // The sentence names the address forms that DO work, so it goes back verbatim.
    h.installer.install.mockRejectedValue(
      new UnsupportedSourceUrlError("ext::sh -c 'id > /tmp/pwned'", UNSUPPORTED_GIT_REMOTE_MESSAGE)
    );

    const res = await install({ source: "ext::sh -c 'id > /tmp/pwned'" }, 'x');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(UNSUPPORTED_GIT_REMOTE_MESSAGE);
    expect(JSON.stringify(res.body)).not.toContain('ext::');
  });

  it('returns 409 with the conflicts when installer.install throws ConflictError', async () => {
    const conflicts = [
      {
        level: 'error' as const,
        type: 'skill-name' as const,
        description: 'a skill named "deploy" is already installed',
      },
    ];
    h.installer.install.mockRejectedValue(new ConflictError(conflicts));

    const res = await install();

    expect(res.status).toBe(409);
    expect(res.body.conflicts).toEqual(conflicts);
  });

  it('returns 400 for InvalidPackageError, with each refusal code beside its message when it has one (DOR-3293)', async () => {
    h.installer.install.mockRejectedValueOnce(
      new InvalidPackageError(['manifest.version required'])
    );
    const plain = await install();
    expect(plain.status).toBe(400);
    expect(plain.body.errors).toEqual(['manifest.version required']);
    expect(plain.body).not.toHaveProperty('codes');

    h.installer.install.mockRejectedValueOnce(
      new InvalidPackageError(
        ['Report tools can’t be installed.'],
        ['EXTENSION_CALLED_APP_INVALID']
      )
    );
    const coded = await install();
    expect(coded.status).toBe(400);
    expect(coded.body.codes).toEqual(['EXTENSION_CALLED_APP_INVALID']);
    expect(h.onPluginsChanged).not.toHaveBeenCalled();
  });

  it('returns 403 and projects nothing when projectPath is outside the boundary', async () => {
    const res = await install({ projectPath: '/etc/evil' });

    expect(res.status).toBe(403);
    expect(h.installer.install).not.toHaveBeenCalled();
    expect(h.onPluginsChanged).not.toHaveBeenCalled();
  });
});

describe("an agent's global install (DOR-2306)", () => {
  let stagedDir: string;

  /** Preview a staged package that runs `hooks`, as the real installer would. */
  function previewing(hooks: DisclosedEffects['hooks']) {
    h.installer.preview.mockResolvedValue({
      manifest: buildSamplePluginManifest(),
      packagePath: stagedDir,
      preview: {
        ...buildEmptyPermissionPreview(),
        hooks: hooks.map((hook) => ({ event: hook.event, command: hook.command })),
      },
    });
  }

  beforeEach(() => {
    h.agentHeader = 'agent-token';
    stagedDir = tempDir('agent-install-staged-');
    writeFileSync(join(stagedDir, 'hooks.sh'), 'echo hi');
    h.installer.install.mockResolvedValue(buildSampleInstallResult());
  });

  afterEach(() => {
    rmSync(stagedDir, { recursive: true, force: true });
  });

  it('asks a person before a package that runs things lands in every chat (the C1 exploit)', async () => {
    previewing(shownDisclosure.hooks);

    const first = await install({ approvedDisclosure: shownDisclosure });

    expect(first.status).toBe(202);
    expect(first.body.status).toBe('requires_confirmation');
    expect(h.installer.install).not.toHaveBeenCalled();
    const [card] = h.approvals.listPending();
    expect(card?.detail).toContain('echo hi');
    expect(card?.detail).toContain('Version "1.0.0"');

    h.approvals.grant(card!.approvalId);
    const granted = await install({ confirmationToken: first.body.confirmationToken });

    expect(granted.status).toBe(200);
    expect(h.installer.install.mock.calls[0][0].approvedDisclosure).toEqual(shownDisclosure);
    expect(h.consent.settle).toHaveBeenCalledWith(expect.objectContaining({ global: true }), {
      disclosed: shownDisclosure,
      contentHash: expect.stringMatching(/^sha256:/),
    });
  });

  it('asks before replacing an existing global package, even one that runs nothing', async () => {
    writePackageManifest(join(h.dorkHome, 'plugins', 'sample-plugin'), {
      ...buildSamplePluginManifest(),
    });
    previewing([]);

    const res = await install();

    expect(res.status).toBe(202);
    expect(h.installer.install).not.toHaveBeenCalled();
  });

  it('installs a new package that runs nothing without a card, held to its preview, files and type (DOR-2325)', async () => {
    previewing([]);

    const res = await install({ approvedDisclosure: shownDisclosure });

    expect(res.status).toBe(200);
    expect(h.approvals.listPending()).toEqual([]);
    // Held to what was previewed, not to what the agent claimed.
    expect(h.installer.install.mock.calls[0][0]).toMatchObject({
      approvedDisclosure: expect.objectContaining({ hooks: [] }),
      approvedContentHash: expect.stringMatching(/^sha256:/),
      approvedPackageType: 'plugin',
    });
    expect(h.consent.settle).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('installs nothing when the person says no', async () => {
    previewing(shownDisclosure.hooks);
    const first = await install();
    h.approvals.deny(h.approvals.listPending()[0]!.approvalId, 'no');

    const res = await install({ confirmationToken: first.body.confirmationToken });

    expect(res.status).toBe(403);
    expect(h.installer.install).not.toHaveBeenCalled();
    expect(h.consent.settle).not.toHaveBeenCalled();
  });

  it('does not ask about a project install of a plugin, whose hooks are gated when projected', async () => {
    previewing(shownDisclosure.hooks);

    const res = await install({ projectPath: project() });

    expect(res.status).toBe(200);
    expect(h.approvals.listPending()).toEqual([]);
    // Still held to what the preview fetched (DOR-2325).
    expect(h.installer.install.mock.calls[0][0]).toMatchObject({
      approvedContentHash: expect.stringMatching(/^sha256:/),
      approvedPackageType: 'plugin',
    });
  });
});

describe("an agent's install of an agent package (DOR-2325)", () => {
  let stagedDir: string;
  const installHelper = (body: object = {}) => install(body, 'helper');

  beforeEach(() => {
    h.agentHeader = 'agent-token';
    stagedDir = tempDir('agent-package-staged-');
    mkdirSync(join(stagedDir, '.claude', 'skills', 'ship'), { recursive: true });
    writeFileSync(join(stagedDir, '.claude', 'skills', 'ship', 'SKILL.md'), '# ship');
    h.installer.install.mockResolvedValue({
      ...buildSampleInstallResult(),
      packageName: 'helper',
      type: 'agent',
    });
    // A staged agent package whose skill may run Bash without asking.
    h.installer.preview.mockResolvedValue({
      manifest: { ...buildSamplePluginManifest(), name: 'helper', type: 'agent' },
      packagePath: stagedDir,
      preview: {
        ...buildEmptyPermissionPreview(),
        skillTools: [{ source: '.claude/skills/ship/SKILL.md', skill: 'ship', tools: ['Bash(*)'] }],
      },
    });
  });

  afterEach(() => {
    rmSync(stagedDir, { recursive: true, force: true });
  });

  it('gets a card naming where it lands and what its skills do, and lands nothing until a person approves (the exploit)', async () => {
    const first = await installHelper();

    expect(first.status).toBe(202);
    expect(h.installer.install).not.toHaveBeenCalled();
    const [card] = h.approvals.listPending();
    expect(card?.capabilityId).toBe('marketplace.install');
    expect(card?.detail).toContain('Bash(*)');
    expect(card?.detail).toContain(join(h.dorkHome, 'agents', 'helper'));

    h.approvals.grant(card!.approvalId);
    const granted = await installHelper({ confirmationToken: first.body.confirmationToken });

    expect(granted.status).toBe(200);
    // Held to the bytes and the disclosure the card showed.
    expect(h.installer.install.mock.calls[0][0]).toMatchObject({
      approvedContentHash: expect.stringMatching(/^sha256:/),
      approvedDisclosure: expect.objectContaining({
        skillTools: [expect.objectContaining({ tools: ['Bash(*)'] })],
      }),
    });
  });

  it('asks for a project-scoped call too: an agent package always lands in its own folder', async () => {
    const res = await installHelper({ projectPath: project() });
    expect(res.status).toBe(202);
    expect(h.installer.install).not.toHaveBeenCalled();
  });

  it('lands nothing when the person turns the card down', async () => {
    const first = await installHelper();
    h.approvals.deny(h.approvals.listPending()[0]!.approvalId, 'no');

    const res = await installHelper({ confirmationToken: first.body.confirmationToken });

    expect(res.status).toBe(403);
    expect(h.installer.install).not.toHaveBeenCalled();
  });

  it('cannot spend an approval on different bytes', async () => {
    const first = await installHelper();
    h.approvals.grant(h.approvals.listPending()[0]!.approvalId);
    writeFileSync(join(stagedDir, '.claude', 'skills', 'ship', 'SKILL.md'), '# ship, changed');

    const replay = await installHelper({ confirmationToken: first.body.confirmationToken });

    expect(replay.status).toBe(202);
    expect(h.installer.install).not.toHaveBeenCalled();
  });
});

describe('the tier gate on the mutation routes (DOR-467)', () => {
  it('an AGENT gets an approval request instead of an uninstall', async () => {
    // An in-session agent's CLI attaches X-DorkOS-Agent, which is how this
    // route tells it apart from the person in the app.
    h.agentHeader = 'agent-token';

    const res = await h.post('/packages/demo-plugin/uninstall', { purge: true });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'approval_required',
      capabilityId: 'marketplace.uninstall',
      approvalToken: expect.any(String),
      retry: { field: 'x-dorkos-approval' },
    });
    expect(h.uninstallFlow.uninstall).not.toHaveBeenCalled();
    expect(h.onPluginsChanged).not.toHaveBeenCalled();
  });

  it('the person in the app is not asked to approve their own click', async () => {
    h.uninstallFlow.uninstall.mockResolvedValue(uninstallResult('demo-plugin'));

    const res = await h.post('/packages/demo-plugin/uninstall', {});

    expect(res.status).toBe(200);
    expect(h.uninstallFlow.uninstall).toHaveBeenCalled();
  });

  it('an agent may still INSTALL without an approval: install is tier act', async () => {
    // A new global package that runs nothing on its own gets no card.
    h.agentHeader = 'agent-token';
    const stagedDir = tempDir('tier-act-staged-');
    h.installer.preview.mockResolvedValue({
      manifest: { ...buildSamplePluginManifest(), name: 'demo-plugin' },
      packagePath: stagedDir,
      preview: buildEmptyPermissionPreview(),
    });
    h.installer.install.mockResolvedValue({
      ...buildSampleInstallResult(),
      packageName: 'demo-plugin',
    });

    const res = await install({}, 'demo-plugin');

    expect(res.status).toBe(200);
    expect(h.installer.install).toHaveBeenCalled();
    rmSync(stagedDir, { recursive: true, force: true });
  });
});
