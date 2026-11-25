/**
 * The census's tag gate (DOR-4030): the real release workflows pass, and
 * dropping the gate from any publishing job, routing around it, letting a job
 * that names a secret environment run on anything but main's own copy
 * dispatched on main, or letting a main-dispatch job drop its first-step
 * refusal, fails the census. A job that only writes with GITHUB_TOKEN may run
 * on a `v*` tag push instead (publish-community.yml).
 */
import { describe, expect, it } from 'vitest';
import { checkTagGate, namedEnvironments, opensWith } from '../tag-gate.ts';
import { realWorkflows } from './fixture.ts';

const TAG = "startsWith(github.ref, 'refs/tags/v')";
const MAIN = "github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'";

/** The real repo's config and workflows, with one workflow file's text replaced. */
function withWorkflow(file: string, edit: (text: string) => string) {
  const { files, workflows } = realWorkflows({ file, change: edit });
  return checkTagGate(files, workflows);
}

/** Each finding as `<code without tag-gate/> <job id>`, in order. */
const found = (findings: ReturnType<typeof checkTagGate>) =>
  findings.map((f) => `${f.code.replace(/^tag-gate\//, '')} ${f.where}`);

describe('checkTagGate on the real release workflows', () => {
  it('passes as committed; only publish-community.yml runs on a tag push, the rest on a dispatch', () => {
    const { files, workflows } = realWorkflows();
    expect(files.config.tag_gate?.workflows).toHaveLength(4);
    expect(files.config.tag_gate?.environments).toEqual(['release', 'release-mirrors']);
    expect(checkTagGate(files, workflows)).toEqual([]);
    for (const file of files.config.tag_gate!.workflows) {
      const wf = workflows.find((w) => w.file === file)!;
      const want = file === 'publish-community.yml' ? ['push'] : ['workflow_dispatch'];
      expect([...wf.triggers.keys()], file).toEqual(want);
    }
  });

  const BUILD_AND_PUSH_IF = `    # census's tag gate checks this line).\n    if: ${MAIN}\n    runs-on: ubuntu-latest\n    # 75 = up to`;
  const COMMUNITY_IF = `    # Publishes, so it runs only on a \`v*\` tag (DOR-4030; the census's tag gate checks this line).\n    if: ${TAG}\n`;
  const HOMEBREW_IF = `    # (DOR-4030; the census's tag gate checks this line).\n    if: ${MAIN}\n    runs-on: ubuntu-latest\n    # HOMEBREW_TAP_TOKEN`;
  const MACOS = `  build-macos:\n    needs: tag-is-on-main\n`;
  const MACOS_IF = `${MACOS}    # Names the \`release\` environment, so main's copy, dispatched on main, only\n    # (DOR-4030; the census's tag gate checks this line).\n    if: ${MAIN}\n`;
  const BUILD_READ_ONLY = `    # Read-only (DOR-4030): this job builds and uploads a run artifact; only\n    # publish may write to a release.\n    permissions:\n      contents: read`;
  const DOCKER_REFUSAL = `[[ "$GITHUB_WORKFLOW_REF" == "$GITHUB_REPOSITORY/.github/workflows/publish-docker.yml@refs/heads/main" ]]`;
  const UNGATED_COMMUNITY = [
    'ungated-job build-and-publish',
    'write-no-main-refusal build-and-publish',
  ];
  const UNGATED_WINDOWS = ['ungated-job build-windows', 'write-no-main-refusal build-windows'];

  // [what goes wrong, file, from, to, findings, text the first finding's message or fix carries]
  it.each<[string, string, string, string, string[], string?]>([
    [
      'a publish job loses its main-dispatch condition',
      'publish-docker.yml',
      BUILD_AND_PUSH_IF,
      BUILD_AND_PUSH_IF.replace(`    if: ${MAIN}\n`, ''),
      ['ungated-job build-and-push'],
      `\`if: ${TAG}\` or \`if: ${MAIN}\``,
    ],
    [
      'the Community publish job loses its v* tag condition',
      'publish-community.yml',
      COMMUNITY_IF,
      '',
      UNGATED_COMMUNITY,
    ],
    [
      'the Community publish job routes around its tag with a top-level ||',
      'publish-community.yml',
      `if: ${TAG}\n`,
      `if: ${TAG} || github.event_name == 'push'\n`,
      UNGATED_COMMUNITY,
    ],
    [
      'a v* tag job is given a secret environment',
      'publish-community.yml',
      COMMUNITY_IF,
      `${COMMUNITY_IF}    environment: release\n`,
      [
        'environment-not-main-dispatch build-and-publish',
        'environment-no-main-refusal build-and-publish',
      ],
      'A `v*` tag is not a way into a secret environment.',
    ],
    [
      'the job naming release-mirrors loses its main-dispatch condition',
      'update-homebrew.yml',
      HOMEBREW_IF,
      `    runs-on: ubuntu-latest\n    # HOMEBREW_TAP_TOKEN`,
      ['environment-not-main-dispatch update-formula'],
      'names the release-mirrors environment',
    ],
    [
      'every publishing job, and only those, loses its first-step refusal',
      'publish-docker.yml',
      DOCKER_REFUSAL,
      'true',
      [
        'write-no-main-refusal build-and-push',
        'write-no-main-refusal build-and-push-hub',
        'environment-no-main-refusal mirror-docker-hub',
      ],
    ],
    [
      'the refusal names another workflow file',
      'update-homebrew.yml',
      'workflows/update-homebrew.yml@refs/heads/main',
      'workflows/other.yml@refs/heads/main',
      ['environment-no-main-refusal update-formula'],
    ],
    [
      // Fail closed: an environment expression may name a secret environment.
      'a job whose environment is an expression runs on a v* tag',
      'desktop-release.yml',
      MACOS_IF,
      `${MACOS}    if: ${TAG}\n`,
      ['environment-not-main-dispatch build-macos'],
      'its environment is an expression',
    ],
    [
      'the desktop publish job routes around the gate with a top-level ||',
      'desktop-release.yml',
      `    if: ${MAIN} && inputs.tag != ''`,
      `    if: ${MAIN} || inputs.tag != ''`,
      ['ungated-job publish'],
    ],
    [
      'a build job is given a write token',
      'desktop-release.yml',
      BUILD_READ_ONLY,
      '    permissions:\n      contents: write',
      UNGATED_WINDOWS,
    ],
    [
      'a build job is given only an OIDC token (it can sign attestations)',
      'desktop-release.yml',
      BUILD_READ_ONLY,
      '    permissions:\n      contents: read\n      id-token: write',
      UNGATED_WINDOWS,
    ],
  ])('fails when %s', (_label, file, from, to, want, text) => {
    const findings = withWorkflow(file, (t) => t.replaceAll(from, to));
    expect(found(findings)).toEqual(want);
    if (text) expect(`${findings[0]!.message}\n${findings[0]!.fix}`).toContain(text);
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
