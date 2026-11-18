/**
 * Checks the Release Publish workflow's `publish` job runs from main's copy
 * just before it hands tarballs to npm (DOR-4638). Security's rule: the person's
 * approval is checked inside the job, because a local check is skippable and
 * the agents' admin token can edit the environment's reviewers.
 *
 * Usage (one check per call, every value from `env:`):
 *   node release-branch/publish-gate.ts approval <repo> <run-id> <approver> <approver-id> <actor>
 *   node release-branch/publish-gate.ts tip <repo> <version> <expected-sha>
 *   node release-branch/publish-gate.ts tarball <file.tgz> <package-name> <version>
 *   node release-branch/publish-gate.ts integrity <file.tgz>   (prints npm's dist.integrity form)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseBranchName, assertReleaseBranchTip } from './rules.ts';

/** The GitHub environment every npm publish waits on. */
export const NPM_RELEASE_ENVIRONMENT = 'npm-release';

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** The one GitHub account allowed to approve a publish. */
export interface PublishApprover {
  /** Its login, for messages and the dispatcher check. */
  login: string;
  /** Its numeric user id, which, unlike a login, can never pass to someone else. */
  id: number;
}

/**
 * Require `GET /repos/{repo}/actions/runs/{id}/approvals` to show the
 * `npm-release` deployment approved by the named approver and nobody else,
 * and the approver to be a different account from the one that started the run.
 */
export function assertPublishApproval(
  value: unknown,
  approverAccount: PublishApprover,
  actor: string
): void {
  const { login: approver, id } = approverAccount;
  if (!LOGIN.test(approver) || !LOGIN.test(actor) || !Number.isSafeInteger(id) || id < 1)
    throw Error('The approver and the run actor must both be GitHub accounts.');
  if (approver.toLowerCase() === actor.toLowerCase())
    throw Error('The account that started the publish cannot also be its approver.');
  if (!Array.isArray(value)) throw Error('The publish approvals are unavailable.');
  const forRelease = value.filter(
    (row: unknown) =>
      isRecord(row) &&
      Array.isArray(row.environments) &&
      row.environments.some((env: unknown) => isRecord(env) && env.name === NPM_RELEASE_ENVIRONMENT)
  ) as Record<string, unknown>[];
  if (!forRelease.length) throw Error('Nobody has approved this npm-release deployment.');
  for (const row of forRelease) {
    const login = isRecord(row.user) && typeof row.user.login === 'string' ? row.user.login : '';
    const userId = isRecord(row.user) ? row.user.id : undefined;
    if (row.state !== 'approved' || userId !== id || login.toLowerCase() !== approver.toLowerCase())
      throw Error(
        `The npm-release deployment was ${String(row.state)} by "${login}", not approved by ${approver}.`
      );
  }
}

/** Require a packed tarball's own package.json to name exactly this package and version. */
export function assertTarballManifest(manifest: string, name: string, version: string): void {
  let value: unknown;
  try {
    value = JSON.parse(manifest);
  } catch {
    value = undefined;
  }
  if (!isRecord(value) || value.name !== name || value.version !== version)
    throw Error(`The tarball is not ${name}@${version}.`);
}

/** A tarball's integrity in npm's `dist.integrity` form (`sha512-<base64>`). */
export function tarballIntegrity(bytes: Uint8Array): string {
  return 'sha512-' + createHash('sha512').update(bytes).digest('base64');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function gh(path: string): unknown {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
}

function main(args: readonly string[]): void {
  const [check, ...rest] = args;
  const repo = rest[0] ?? '';
  if (check === 'integrity' && rest.length === 1) {
    console.log(tarballIntegrity(readFileSync(rest[0])));
    return;
  }
  if (check !== 'tarball' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw Error('The repository must be owner/name.');
  if (check === 'approval' && rest.length === 5) {
    const [, runId, approver, approverId, actor] = rest;
    if (!/^[1-9]\d*$/.test(runId) || !/^[1-9]\d*$/.test(approverId))
      throw Error('The run id and the approver id must be numbers.');
    assertPublishApproval(
      gh(`repos/${repo}/actions/runs/${runId}/approvals`),
      { login: approver, id: Number(approverId) },
      actor
    );
    console.log(`Approved by ${approver}.`);
  } else if (check === 'tip' && rest.length === 3) {
    const [, version, expected] = rest;
    const branch = `release/v${version}`;
    assertReleaseBranchName(branch, version);
    assertReleaseBranchTip(gh(`repos/${repo}/branches/${branch}`), branch, expected, expected);
    console.log(`${branch} is still at ${expected}.`);
  } else if (check === 'tarball' && rest.length === 3) {
    const [file, name, version] = rest;
    const manifest = execFileSync('tar', ['-xzOf', file, 'package/package.json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    assertTarballManifest(manifest, name, version);
    console.log(`${file} is ${name}@${version}.`);
  } else throw Error('Usage: publish-gate.ts approval|tip|tarball|integrity <args>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
