/**
 * The Codex seccomp profile is Docker's default plus ONE rule (DOR-3800).
 *
 * Security reviewed exactly that widening: five syscalls allowed without
 * conditions so Codex's bubblewrap sandbox can build its namespaces, and
 * nothing else. This test fails if the shipped profile differs from the pinned
 * upstream file in any other way, and if the pinned upstream copy itself is
 * edited (its sha256 is checked against the bytes moby/profiles serves at that
 * commit). Runs offline: the upstream copy lives in the repo beside the profile.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';

/** moby/profiles commit the profile is built on. */
const UPSTREAM_COMMIT = '9ee3204f0d0cfa19ca2c6a7b0fcf5a2b353954ae';
/** sha256 of `seccomp/default.json` at UPSTREAM_COMMIT, as served raw by GitHub. */
const UPSTREAM_SHA256 = '3320527d4568265ac97a077609b1bfd4cfd0d789eeb9239b7e094b1526675406';
/** The one widening Security approved, exactly. */
const ADDED_SYSCALLS = ['clone', 'mount', 'pivot_root', 'umount2', 'unshare'];

const repoRoot = path.resolve(import.meta.dirname, '../..');
const dir = path.join(repoRoot, 'docker/seccomp');
const upstreamPath = path.join(dir, `upstream-default-${UPSTREAM_COMMIT.slice(0, 12)}.json`);
const profilePath = path.join(dir, 'dorkos-codex.json');

type Rule = Record<string, unknown>;
type Profile = Record<string, unknown> & { syscalls: Rule[] };

/**
 * Every way `profile` differs from `upstream` other than the one approved
 * rule. An empty list means the profile is exactly upstream plus that rule.
 */
function wideningProblems(upstream: Profile, profile: Profile): string[] {
  const problems: string[] = [];
  const keys = (o: object) => Object.keys(o).sort();
  if (!isDeepStrictEqual(keys(profile), keys(upstream))) {
    problems.push(`top-level keys differ: ${keys(profile).join(',')}`);
  }
  for (const key of keys(upstream)) {
    if (key !== 'syscalls' && !isDeepStrictEqual(profile[key], upstream[key])) {
      problems.push(`top-level "${key}" differs from upstream`);
    }
  }
  if (!Array.isArray(profile.syscalls)) return [...problems, 'syscalls is not a list'];
  if (profile.syscalls.length !== upstream.syscalls.length + 1) {
    return [
      ...problems,
      `expected ${upstream.syscalls.length + 1} syscall rules, found ${profile.syscalls.length}`,
    ];
  }
  // Exactly one rule, removed from anywhere, must leave upstream's list intact.
  const extraAt = profile.syscalls.findIndex((_, i) =>
    isDeepStrictEqual(
      profile.syscalls.filter((__, j) => j !== i),
      upstream.syscalls
    )
  );
  if (extraAt === -1) return [...problems, 'an upstream syscall rule was changed'];

  const added = profile.syscalls[extraAt]!;
  const extraKeys = keys(added).filter((k) => !['names', 'action', 'comment'].includes(k));
  if (extraKeys.length > 0) problems.push(`added rule carries ${extraKeys.join(',')}`);
  if (added.action !== 'SCMP_ACT_ALLOW')
    problems.push(`added rule action is ${String(added.action)}`);
  if (typeof added.comment !== 'string' && added.comment !== undefined) {
    problems.push('added rule comment is not text');
  }
  const names = Array.isArray(added.names) ? [...(added.names as string[])].sort() : [];
  if (!isDeepStrictEqual(names, ADDED_SYSCALLS)) {
    problems.push(`added rule allows ${names.join(',')}, not ${ADDED_SYSCALLS.join(',')}`);
  }
  return problems;
}

const upstreamBytes = readFileSync(upstreamPath);
const upstream = JSON.parse(upstreamBytes.toString('utf8')) as Profile;
const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as Profile;

/** A fresh copy of the shipped profile, for the mutation rows to break. */
function shipped(): Profile {
  return structuredClone(profile);
}
/** The DorkOS rule in `p`, found by its exact syscall list. */
function addedRule(p: Profile): Rule {
  return p.syscalls.find((r) => isDeepStrictEqual(r.names, ADDED_SYSCALLS))!;
}

describe('the Codex seccomp profile', () => {
  it('keeps the pinned upstream copy byte for byte', () => {
    expect(createHash('sha256').update(upstreamBytes).digest('hex')).toBe(UPSTREAM_SHA256);
  });

  it('names the pinned commit in its README', () => {
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toContain(UPSTREAM_COMMIT);
  });

  it('is upstream plus the one approved rule, and nothing else', () => {
    expect(wideningProblems(upstream, profile)).toEqual([]);
  });

  it('is the exact file dorkos.ai serves at /dorkos-codex.json', () => {
    const served = readFileSync(path.join(repoRoot, 'apps/site/public/dorkos-codex.json'));
    expect(served.equals(readFileSync(profilePath))).toBe(true);
  });

  it('carries the upstream licence beside it', () => {
    const licence = readFileSync(path.join(dir, 'LICENSE'), 'utf8');
    expect(licence).toContain('Apache License');
    expect(licence).toContain('Version 2.0, January 2004');
  });

  describe('refuses any other widening', () => {
    it('a sixth syscall in the added rule', () => {
      const p = shipped();
      (addedRule(p).names as string[]).push('setns');
      expect(wideningProblems(upstream, p)).toContainEqual(
        expect.stringContaining('added rule allows')
      );
    });

    it('a second added rule', () => {
      const p = shipped();
      p.syscalls.push({ names: ['setns'], action: 'SCMP_ACT_ALLOW' });
      expect(wideningProblems(upstream, p)).not.toEqual([]);
    });

    it('a condition or capability gate on the added rule', () => {
      const p = shipped();
      addedRule(p).includes = { caps: ['CAP_SYS_ADMIN'] };
      expect(wideningProblems(upstream, p)).toContainEqual(
        expect.stringContaining('carries includes')
      );
    });

    it('a different action on the added rule', () => {
      const p = shipped();
      addedRule(p).action = 'SCMP_ACT_LOG';
      expect(wideningProblems(upstream, p)).toContainEqual(expect.stringContaining('action'));
    });

    it('an edit to an upstream rule', () => {
      const p = shipped();
      // Upstream allows ptrace only to a process holding CAP_SYS_PTRACE.
      const ptrace = p.syscalls.find((r) =>
        isDeepStrictEqual(r.includes, { caps: ['CAP_SYS_PTRACE'] })
      )!;
      delete ptrace.includes;
      expect(wideningProblems(upstream, p)).toContain('an upstream syscall rule was changed');
    });

    it('a changed default action', () => {
      const p = shipped();
      p.defaultAction = 'SCMP_ACT_ALLOW';
      expect(wideningProblems(upstream, p)).toContain(
        'top-level "defaultAction" differs from upstream'
      );
    });

    it('a new top-level key', () => {
      const p = shipped();
      p.listenerPath = '/tmp/agent.sock';
      expect(wideningProblems(upstream, p)).toContainEqual(
        expect.stringContaining('top-level keys differ')
      );
    });
  });
});

/** Lines that are not shell or YAML comments: comments may name what is banned. */
function codeLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** Ways to get the sandbox going by weakening the container or the host instead. */
const WEAKENINGS = [
  /--privileged/,
  /privileged:\s*true/,
  /--cap-add/,
  /cap_add/,
  /unconfined/,
  /sysctl\s+(-w|--write)/,
  /apparmor_parser/,
  /aa-teardown/,
  /aa-complain/,
  /aa-disable/,
  /systemctl\s+stop\s+apparmor/,
  /apparmor_restrict_unprivileged_userns\s*=/,
  /unprivileged_userns_clone\s*=/,
  /\/proc\/sys\//,
];

/** The job's steps, read without a YAML parser: every `uses:` and every `run:` body. */
function jobSteps(job: string): { uses: string[]; runs: string[] } {
  const lines = job.split('\n');
  const uses = lines.flatMap((line) => line.match(/^ {6}- uses: (\S+)$/)?.slice(1) ?? []);
  const runs: string[] = [];
  lines.forEach((line, i) => {
    const run = line.match(/^ {8}run: (.*)$/)?.[1];
    if (run === undefined) return;
    if (run !== '|') return void runs.push(run);
    const body: string[] = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() !== '' && !next.startsWith(' '.repeat(10))) break;
      body.push(next.slice(10));
    }
    runs.push(body.join('\n').trimEnd());
  });
  return { uses, runs };
}

const DOCKER_GUIDE = path.join('docs', 'self-hosting', 'docker.mdx');
const CODEX_SECTION = '## Running Codex in Docker';

describe('the profile stays opt-in and the host stays at its defaults', () => {
  it('appears only in the Codex section of the Docker guide', () => {
    const docs = readdirSync(path.join(repoRoot, 'docs'), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.mdx'))
      .map((file) => path.join('docs', file));
    const files = [...docs, 'apps/site/public/compose.yml', 'docker-compose.caddy.yml'];
    const hits: string[] = [];
    let sawGuide = false;
    for (const rel of files) {
      let text = readFileSync(path.join(repoRoot, rel), 'utf8');
      if (rel === DOCKER_GUIDE) {
        sawGuide = true;
        const sections = text.split(/\n(?=## )/);
        const codex = sections.filter((s) => s.startsWith(CODEX_SECTION));
        expect(codex).toHaveLength(1);
        // One docker run line and one Compose entry, both naming the shipped profile.
        expect(codex[0]!.match(/--security-opt \S+/g)).toEqual([
          '--security-opt seccomp=dorkos-codex.json',
        ]);
        expect(codex[0]!.match(/security_opt:/g)).toHaveLength(1);
        expect(codex[0]!.match(/seccomp=\S+/g)).toEqual([
          'seccomp=dorkos-codex.json',
          'seccomp=./dorkos-codex.json',
        ]);
        text = sections.filter((s) => !s.startsWith(CODEX_SECTION)).join('\n');
      }
      if (/security[-_]opt|seccomp=/.test(text)) hits.push(rel);
    }
    // A scan that read nothing would pass; make sure it read the guide.
    expect(sawGuide).toBe(true);
    expect(docs.length).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });

  it('never tells anyone to weaken the container or the host', () => {
    for (const rel of [DOCKER_GUIDE, 'docker/seccomp/README.md']) {
      const text = readFileSync(path.join(repoRoot, rel), 'utf8');
      expect(text.length).toBeGreaterThan(0);
      for (const pattern of WEAKENINGS)
        expect(text, `${rel} matches ${pattern}`).not.toMatch(pattern);
    }
  });

  it('proves it in CI without weakening the container or the host', () => {
    const workflow = readFileSync(
      path.join(repoRoot, '.github/workflows/cli-smoke-test.yml'),
      'utf8'
    );
    const job = workflow.split('\n  codex-docker-sandbox:\n')[1]!.split(/\n {2}[a-z][\w-]*:\n/)[0]!;
    // Exactly these steps: nothing that runs before, after or beside the check.
    expect(jobSteps(job)).toEqual({
      uses: ['actions/checkout@v7', 'actions/download-artifact@v8'],
      runs: [
        'docker build --target runtime -t dorkos-runtime .',
        [
          'for knob in kernel.apparmor_restrict_unprivileged_userns kernel.unprivileged_userns_clone user.max_user_namespaces; do',
          '  echo "$knob = $(sysctl -n "$knob" 2>/dev/null || echo absent)"',
          'done',
          'echo "apparmor enabled = $(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || echo absent)"',
          `echo "docker security options = $(docker info --format '{{json .SecurityOptions}}')"`,
        ].join('\n'),
        'bash scripts/codex-docker-sandbox-check.sh dorkos-runtime docker/seccomp/dorkos-codex.json',
      ],
    });
    const code = codeLines(job);
    // No run: hiding at another indent, no way to go green on a red step.
    expect(code.match(/\brun:/g)).toHaveLength(3);
    expect(code).not.toMatch(/continue-on-error/);
    expect(code).not.toMatch(/^\s*if:/m);
    const script = codeLines(
      readFileSync(path.join(repoRoot, 'scripts/codex-docker-sandbox-check.sh'), 'utf8')
    );
    for (const [name, text] of [
      ['the job', code],
      ['the check script', script],
    ] as const) {
      expect(text, `${name} uses sudo`).not.toMatch(/\bsudo\b/);
      for (const pattern of WEAKENINGS)
        expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
    }
    // The script's two runs: the shipped profile, then Docker's default.
    expect(script).toContain('WITH=$(run_probe --security-opt "seccomp=$PROFILE")');
    expect(script).toContain('DEFAULT=$(run_probe)');
  });
});
