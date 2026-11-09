/**
 * The census's tag gate (DOR-4030): the real release workflows pass, and
 * dropping the tag condition from any publishing job, or routing around it,
 * fails the census.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadHandFiles, type HandFiles } from '../load.ts';
import { checkTagGate, gatesOnTag } from '../tag-gate.ts';
import { loadWorkflows, type WorkflowModel } from '../workflows.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const TAG = "startsWith(github.ref, 'refs/tags/v')";

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
    writeFileSync(path.join(dir, f), f === file ? edit(text) : text);
  }
  const workflows = loadWorkflows(root, files.config.workflows_dir, () => {});
  return checkTagGate(files, workflows);
}

describe('checkTagGate on the real release workflows', () => {
  it('passes as committed', () => {
    const { files, workflows } = realRepo();
    expect(files.config.tag_gate?.workflows).toHaveLength(4);
    expect(checkTagGate(files, workflows)).toEqual([]);
  });

  it('fails when a publish job loses its tag condition', () => {
    const findings = withWorkflow('publish-docker.yml', (t) => t.replace(`    if: ${TAG}\n`, ''));
    expect(findings.map((f) => [f.code, f.where])).toEqual([
      ['tag-gate/ungated-job', 'build-and-push'],
    ]);
  });

  it('fails when the job naming release-publish loses its tag condition', () => {
    const findings = withWorkflow('update-homebrew.yml', (t) => t.replace(`    if: ${TAG}\n`, ''));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('names the release-publish environment');
  });

  it('fails when the desktop publish job routes around the tag with a top-level ||', () => {
    const findings = withWorkflow('desktop-release.yml', (t) =>
      t.replace(
        `    if: ${TAG} && !inputs.dry_run`,
        `    if: ${TAG} || github.event_name == 'workflow_dispatch'`
      )
    );
    expect(findings.map((f) => f.where)).toEqual(['publish']);
  });

  it('fails when a build job is given a write token', () => {
    const findings = withWorkflow('desktop-release.yml', (t) =>
      t.replace(
        '    # Read-only (DOR-4030): this job builds, signs and uploads a run artifact.\n    # Only publish, which runs on a `v*` tag alone, may write to a release.\n    permissions:\n      contents: read',
        '    permissions:\n      contents: write'
      )
    );
    expect(findings.map((f) => f.where)).toEqual(['build-macos']);
  });
});

describe('gatesOnTag', () => {
  it.each([
    [TAG, true],
    [`\${{ ${TAG} }}`, true],
    [`${TAG} && vars.X == 'true'`, true],
    [`${TAG} && (a || b)`, true],
    [`${TAG} || a`, false],
    [`${TAG} && a || b`, false],
    [`a && ${TAG}`, false],
    ["startsWith(github.ref, 'refs/tags/')", false],
    [true, false],
    [undefined, false],
  ])('%s -> %s', (cond, want) => {
    expect(gatesOnTag(cond as string | boolean | undefined, TAG)).toBe(want);
  });
});
