/**
 * The census's tag gate (DOR-4030): the real release workflows pass, and
 * dropping the gate from any publishing job, routing around it, letting a job
 * that names a secret environment run on anything but main's own copy
 * dispatched on main, or letting a main-dispatch job drop its first-step
 * refusal, fails the census. A job that only writes with GITHUB_TOKEN may run
 * on a `v*` tag push instead (publish-community.yml).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadHandFiles, type HandFiles } from '../load.ts';
import { checkTagGate, namedEnvironments, opensWith } from '../tag-gate.ts';
import { loadWorkflows, type WorkflowModel } from '../workflows.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const TAG = "startsWith(github.ref, 'refs/tags/v')";
const MAIN = "github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function realRepo(): { files: HandFiles; workflows: WorkflowModel[] } {
  const files = loadHandFiles(REPO).files!;
  const workflows = loadWorkflows(REPO, files.config.workflows_dir, (f, m) => {
    throw new Error(`${f}: ${m}`);
  });
  return { files, workflows };
}

/** The real repo's config and workflows, with one workflow file's text replaced. */
function withWorkflow(file: string, edit: (text: string) => string) {
  const { files } = realRepo();
  const root = mkdtempSync(path.join(tmpdir(), 'tag-gate-'));
  dirs.push(root);
  const dir = path.join(root, files.config.workflows_dir);
  mkdirSync(dir, { recursive: true });
  for (const f of files.config.tag_gate!.workflows) {
    const text = readFileSync(path.join(REPO, files.config.workflows_dir, f), 'utf8');
    const edited = f === file ? edit(text) : text;
    // An edit that matched nothing would pass vacuously.
    if (f === file) expect(edited).not.toBe(text);
    writeFileSync(path.join(dir, f), edited);
  }
  const workflows = loadWorkflows(root, files.config.workflows_dir, () => {});
  return checkTagGate(files, workflows);
}

/** Codes and job ids of the findings, in order. */
const found = (findings: ReturnType<typeof checkTagGate>) => findings.map((f) => [f.code, f.where]);

describe('checkTagGate on the real release workflows', () => {
  it('passes as committed', () => {
    const { files, workflows } = realRepo();
    expect(files.config.tag_gate?.workflows).toHaveLength(4);
    expect(files.config.tag_gate?.environments).toEqual(['release', 'release-mirrors']);
    expect(checkTagGate(files, workflows)).toEqual([]);
  });

  it('publishes on a tag push only in publish-community.yml; the rest start from a dispatch', () => {
    const { files, workflows } = realRepo();
    for (const file of files.config.tag_gate!.workflows) {
      const wf = workflows.find((w) => w.file === file)!;
      const want = file === 'publish-community.yml' ? ['push'] : ['workflow_dispatch'];
      expect([...wf.triggers.keys()], file).toEqual(want);
    }
  });

  const BUILD_AND_PUSH_IF = `    # census's tag gate checks this line).\n    if: ${MAIN}\n    runs-on: ubuntu-latest\n    # 75 = up to`;
  const COMMUNITY_IF = `    # Publishes, so it runs only on a \`v*\` tag (DOR-4030; the census's tag gate checks this line).\n    if: ${TAG}\n`;

  it('fails when a publish job loses its main-dispatch condition', () => {
    const findings = withWorkflow('publish-docker.yml', (t) =>
      t.replace(
        BUILD_AND_PUSH_IF,
        "    # census's tag gate checks this line).\n    runs-on: ubuntu-latest\n    # 75 = up to"
      )
    );
    expect(found(findings)).toEqual([['tag-gate/ungated-job', 'build-and-push']]);
    expect(findings[0]!.fix).toContain(`\`if: ${TAG}\` or \`if: ${MAIN}\``);
  });

  it('fails when the Community publish job loses its v* tag condition', () => {
    const findings = withWorkflow('publish-community.yml', (t) => t.replace(COMMUNITY_IF, ''));
    expect(found(findings)).toEqual([
      ['tag-gate/ungated-job', 'build-and-publish'],
      ['tag-gate/write-no-main-refusal', 'build-and-publish'],
    ]);
  });

  it('fails when the Community publish job routes around its tag with a top-level ||', () => {
    const findings = withWorkflow('publish-community.yml', (t) =>
      t.replace(
        COMMUNITY_IF,
        COMMUNITY_IF.replace(`if: ${TAG}`, `if: ${TAG} || github.event_name == 'push'`)
      )
    );
    expect(found(findings)).toEqual([
      ['tag-gate/ungated-job', 'build-and-publish'],
      ['tag-gate/write-no-main-refusal', 'build-and-publish'],
    ]);
  });

  it('fails when a v* tag job is given a secret environment', () => {
    const findings = withWorkflow('publish-community.yml', (t) =>
      t.replace(COMMUNITY_IF, `${COMMUNITY_IF}    environment: release\n`)
    );
    expect(found(findings)).toEqual([
      ['tag-gate/environment-not-main-dispatch', 'build-and-publish'],
      ['tag-gate/environment-no-main-refusal', 'build-and-publish'],
    ]);
    expect(findings[0]!.fix).toContain('A `v*` tag is not a way into a secret environment.');
  });

  it('fails when the job naming release-mirrors loses its main-dispatch condition', () => {
    const findings = withWorkflow('update-homebrew.yml', (t) =>
      t.replace(
        `    # (DOR-4030; the census's tag gate checks this line).\n    if: ${MAIN}\n    runs-on: ubuntu-latest\n    # HOMEBREW_TAP_TOKEN`,
        `    runs-on: ubuntu-latest\n    # HOMEBREW_TAP_TOKEN`
      )
    );
    expect(found(findings)).toEqual([['tag-gate/environment-not-main-dispatch', 'update-formula']]);
    expect(findings[0]!.message).toContain('names the release-mirrors environment');
  });

  it('fails when a job naming release-mirrors runs on a v* tag instead of from main', () => {
    const findings = withWorkflow('publish-docker.yml', (t) =>
      t.replace(
        `    if: ${MAIN} && vars.DOCKERHUB_MIRROR`,
        `    if: ${TAG} && vars.DOCKERHUB_MIRROR`
      )
    );
    expect(found(findings)).toEqual([
      ['tag-gate/environment-not-main-dispatch', 'mirror-docker-hub'],
    ]);
  });

  it('fails every publishing job, and only those, that loses its first-step refusal', () => {
    const findings = withWorkflow('publish-docker.yml', (t) =>
      t.replaceAll(
        '[[ "$GITHUB_WORKFLOW_REF" == "$GITHUB_REPOSITORY/.github/workflows/publish-docker.yml@refs/heads/main" ]]',
        'true'
      )
    );
    expect(found(findings)).toEqual([
      ['tag-gate/write-no-main-refusal', 'build-and-push'],
      ['tag-gate/write-no-main-refusal', 'build-and-push-hub'],
      ['tag-gate/environment-no-main-refusal', 'mirror-docker-hub'],
    ]);
  });

  it('fails when the refusal names another workflow file', () => {
    const findings = withWorkflow('update-homebrew.yml', (t) =>
      t.replaceAll(
        'workflows/update-homebrew.yml@refs/heads/main',
        'workflows/other.yml@refs/heads/main'
      )
    );
    expect(found(findings)).toEqual([['tag-gate/environment-no-main-refusal', 'update-formula']]);
  });

  it('reads an environment expression as naming a secret environment (fail closed)', () => {
    const findings = withWorkflow('desktop-release.yml', (t) =>
      t.replace(
        `  build-macos:\n    needs: tag-is-on-main\n    # Names the \`release\` environment, so main's copy, dispatched on main, only\n    # (DOR-4030; the census's tag gate checks this line).\n    if: ${MAIN}\n`,
        `  build-macos:\n    needs: tag-is-on-main\n    if: ${TAG}\n`
      )
    );
    expect(found(findings)).toEqual([['tag-gate/environment-not-main-dispatch', 'build-macos']]);
    expect(findings[0]!.message).toContain('its environment is an expression');
  });

  it('fails when the desktop publish job routes around the gate with a top-level ||', () => {
    const findings = withWorkflow('desktop-release.yml', (t) =>
      t.replace(`    if: ${MAIN} && inputs.tag != ''`, `    if: ${MAIN} || inputs.tag != ''`)
    );
    expect(found(findings)).toEqual([['tag-gate/ungated-job', 'publish']]);
  });

  it('fails when a build job is given a write token', () => {
    const findings = withWorkflow('desktop-release.yml', (t) =>
      t.replace(
        '    # Read-only (DOR-4030): this job builds and uploads a run artifact; only\n    # publish may write to a release.\n    permissions:\n      contents: read',
        '    permissions:\n      contents: write'
      )
    );
    expect(found(findings)).toEqual([
      ['tag-gate/ungated-job', 'build-windows'],
      ['tag-gate/write-no-main-refusal', 'build-windows'],
    ]);
  });

  it('fails when a build job is given only an OIDC token (it can sign attestations)', () => {
    const findings = withWorkflow('desktop-release.yml', (t) =>
      t.replace(
        '    # Read-only (DOR-4030): this job builds and uploads a run artifact; only\n    # publish may write to a release.\n    permissions:\n      contents: read',
        '    permissions:\n      contents: read\n      id-token: write'
      )
    );
    expect(found(findings)).toEqual([
      ['tag-gate/ungated-job', 'build-windows'],
      ['tag-gate/write-no-main-refusal', 'build-windows'],
    ]);
  });
});

describe('namedEnvironments', () => {
  const known = ['release', 'release-mirrors'];
  it.each([
    [undefined, []],
    ['', []],
    ['automation', []],
    ['release', ['release']],
    ["${{ inputs.sign && 'release' || '' }}", known],
    ["${{ format('rel{0}', 'ease') }}", known],
  ])('%s -> %j', (env, want) => {
    expect(namedEnvironments(env, known)).toEqual(want);
  });
});

describe('opensWith', () => {
  it.each([
    [MAIN, true],
    [`\${{ ${MAIN} }}`, true],
    [`${MAIN} && vars.X == 'true'`, true],
    [`${MAIN} && (a || b)`, true],
    [`${MAIN} || a`, false],
    [`${MAIN} && a || b`, false],
    [`a && ${MAIN}`, false],
    ["github.ref == 'refs/heads/main'", false],
    [TAG, false],
    [true, false],
    [undefined, false],
  ])('%s -> %s', (cond, want) => {
    expect(opensWith(cond as string | boolean | undefined, MAIN)).toBe(want);
  });
});
