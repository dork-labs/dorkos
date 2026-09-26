# Local marketplace retained-copy reproduction

Recorded on 2026-09-26 against `7168a5b7c69def16bb2cb48319b24285c9894a3f` on macOS. These are diagnostic fixtures, not passing regression tests or approved behavior. They call the real local carry, disclosure and scan functions. No server, credentials or network service is used; the historical-fetch failure is injected.

See [the recovery evidence matrix](20260926-local-marketplace-recovery-evidence.md) for conclusions and dispositions. Run only in an isolated checkout with dependencies installed (`pnpm install --frozen-lockfile`, then `pnpm --filter @dorkos/server... build`). Save the two code blocks at the paths named below, preserving the directory depth used by their imports. Each fixture cleans up its own temporary directory in `finally`.

## Saved copies and discovery

Save as `.dork/flow/local-recovery-lifecycle/triage/reproduce.ts`, then run:

```sh
pnpm exec tsx .dork/flow/local-recovery-lifecycle/triage/reproduce.ts
```

Observed: both copied scripts retain mode `0755` and print their expected harmless fixture text. The saved skill directory is returned by Harness Sync and its `Bash` declaration by the disclosure reader. Clearing the saved program's execute bits alone does not remove it from disclosure. This diagnoses DOR-2340; it does not exercise an agent or show execution without approval.

```typescript
import { mkdir, writeFile, chmod, stat, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeInstalledFiles } from '../../../../apps/server/src/services/marketplace/lib/installed-files.ts';
import { carryPersonFiles } from '../../../../apps/server/src/services/marketplace/lib/carry-over.ts';
import { readPackagePrograms } from '../../../../apps/server/src/services/marketplace/lib/package-programs.ts';
import { readPackageSkills } from '../../../../apps/server/src/services/marketplace/lib/package-skills.ts';
import { listSkillDirs } from '../../../../packages/harness/src/scan/scanner.ts';
const scratch = await mkdtemp(path.join(import.meta.dirname, 'fixture-'));
const put = async (root: string, rel: string, bytes: string, mode = 0o644) => {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  await chmod(file, mode);
};
try {
  const live = path.join(scratch, 'live'),
    staged = path.join(scratch, 'staged');
  const identity = { name: 'triage', type: 'plugin' as const };
  await put(live, 'bin/tool', '#!/bin/sh\nprintf original', 0o755);
  await put(live, 'settings/command', '#!/bin/sh\nprintf settings', 0o755);
  const old = await computeInstalledFiles(live, {
    identity,
    userEditable: ['settings/command'],
    npmRan: false,
  });
  await put(live, 'bin/tool', '#!/bin/sh\nprintf edited-copy', 0o755);
  await put(live, 'settings/command', '#!/bin/sh\nprintf my-settings', 0o755);
  await put(
    live,
    'skills/x/SKILL.md',
    '---\nname: x\ndescription: fixture\nallowed-tools: Bash\n---\nFixture'
  );
  await put(staged, 'bin/tool', '#!/bin/sh\nprintf new', 0o755);
  await put(staged, 'settings/command', '#!/bin/sh\nprintf new-settings', 0o755);
  await put(staged, 'skills/x', 'new package file blocks old folder');
  const next = await computeInstalledFiles(staged, {
    identity,
    userEditable: ['settings/command'],
    npmRan: false,
  });
  const carried = await carryPersonFiles({
    liveRoot: live,
    stagingDir: staged,
    rOld: old,
    rNew: next,
    oldHasIdentity: true,
  });
  console.log(
    JSON.stringify(
      {
        actions: carried.plan.actions,
        oldMode: (await stat(path.join(staged, 'bin/tool.dork-old'))).mode & 0o777,
        newMode: (await stat(path.join(staged, 'settings/command.dork-new'))).mode & 0o777,
        executedOld: execFileSync(path.join(staged, 'bin/tool.dork-old'), { encoding: 'utf8' }),
        executedNew: execFileSync(path.join(staged, 'settings/command.dork-new'), {
          encoding: 'utf8',
        }),
        programs: await readPackagePrograms(staged, undefined),
        harnessSkills: listSkillDirs(path.join(staged, 'skills'), 'skills', {
          followSymlinks: false,
        }),
        skillDisclosure: await readPackageSkills(staged, undefined),
      },
      null,
      2
    )
  );
  await chmod(path.join(staged, 'bin/tool.dork-old'), 0o644);
  console.log(
    'After chmod, disclosure:',
    (await readPackagePrograms(staged, undefined)).executables
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
```

## Unresolved ownership

Save as `.dork/flow/local-recovery-lifecycle/triage/reproduce-unproven.ts`, then run:

```sh
pnpm exec tsx .dork/flow/local-recovery-lifecycle/triage/reproduce-unproven.ts
```

Observed: no-source uses zero fetches; the injected unavailable historical commit returns fetch-failed. Both keep `unproven: true`, the exact ownership record and `mine.txt` bytes. Persistent coverage already exists in `apps/server/src/services/marketplace/lib/integrity/__tests__/strict-record.test.ts`; this fixture records the triage sequence, not a new suite. DOR-2341 requires an ownership decision, not a silent record rewrite.

```typescript
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { sortUnprovenFiles } from '../../../../apps/server/src/services/marketplace/lib/integrity/unproven-sort.ts';
import { writeInstalledFiles } from '../../../../apps/server/src/services/marketplace/lib/installed-files.ts';
import { noopLogger } from '../../../../packages/shared/src/logger.ts';
const root = await mkdtemp(path.join(import.meta.dirname, 'fixture-unproven-'));
try {
  await writeFile(path.join(root, 'mine.txt'), 'keep my bytes');
  const record = {
    version: 1 as const,
    package: { name: 'triage', type: 'plugin' as const },
    ownedPaths: [],
    files: {},
    pendingDefaults: {},
    userEditable: [],
    unproven: { why: 'no-source' as const, files: { 'mine.txt': 'mine.txt' } },
  };
  let calls = 0;
  const deps = {
    fetcher: {
      fetchAtCommit: async () => {
        calls++;
        throw new Error('historical commit unavailable');
      },
    },
    logger: noopLogger,
  };
  await writeInstalledFiles(root, record);
  for (const from of [
    undefined,
    {
      name: 'triage',
      commitSha: 'a'.repeat(40),
      sourceKey: { cloneUrl: 'https://example.invalid/triage.git', subpath: '.', ref: 'main' },
    },
  ]) {
    if (from)
      await writeInstalledFiles(root, {
        ...record,
        unproven: { ...record.unproven, why: 'fetch-failed', from },
      });
    const before = await readFile(path.join(root, '.dork/installed-files.json'), 'utf8');
    const result = await sortUnprovenFiles(root, deps);
    console.log(
      JSON.stringify({
        result,
        recordUnchanged:
          before === (await readFile(path.join(root, '.dork/installed-files.json'), 'utf8')),
        file: await readFile(path.join(root, 'mine.txt'), 'utf8'),
        fetchCalls: calls,
      })
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
```
