import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fsPromises from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  buildNativeObserver,
  nativeObserverManifestName,
} from '../../scripts/build-native-observer.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(await realpath(tmpdir()), 'native-observer-build-'));
});
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('emits unavailable metadata on unsupported hosts and removes stale helper output', async () => {
  await writeFile(join(directory, 'darwin-process-observer'), 'stale output');
  const result = await buildNativeObserver({
    outputDirectory: directory,
    platform: 'linux',
    arch: 'x64',
  });
  expect(result.availability).toBe('unavailable');
  expect(result.reason).toBe('PLATFORM_UNSUPPORTED');
  expect(result.binary).toBeNull();
  await expect(stat(join(directory, 'darwin-process-observer'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(JSON.parse(await readFile(join(directory, nativeObserverManifestName), 'utf8'))).toEqual(
    result
  );
  for (const source of result.sources) {
    const bytes = await readFile(join(directory, source.name));
    expect(bytes.length).toBe(source.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
  }
});

it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'builds the actual helper once and pins its genuine bytes and source snapshots',
  async () => {
    const result = await buildNativeObserver({ outputDirectory: directory });
    expect(result.availability).toBe('available');
    expect(result.reason).toBeNull();
    expect(result.binary).not.toBeNull();
    const binary = result.binary!;
    const bytes = await readFile(join(directory, binary.name));
    expect(bytes.length).toBe(binary.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(binary.sha256);
    expect((await stat(join(directory, binary.name))).mode & 0o111).not.toBe(0);
    const sourceDigest = createHash('sha256')
      .update(result.sources.map((source) => `${source.name}\0${source.sha256}\n`).join(''))
      .digest('hex');
    expect(result.sourceDigest).toBe(sourceDigest);
    const reply = JSON.parse(
      execFileSync(join(directory, binary.name), ['inspect', String(process.pid)], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
      })
    );
    expect(reply.version).toBe(1);
    expect(reply.processes[0]).toMatchObject({
      kind: 'present',
      identity: { pid: process.pid },
      zombie: false,
    });
    const children = JSON.parse(
      execFileSync(join(directory, binary.name), ['children', String(process.pid)], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
      })
    );
    expect(children).toMatchObject({
      complete: true,
      parentBefore: { pid: process.pid },
      parentAfter: { pid: process.pid },
    });
    // The queried Node caller synchronously owns this one helper original. It must
    // not enroll that short-lived observation auxiliary as a browser descendant.
    expect(children.processes).toEqual([]);
    expect(JSON.parse(await readFile(join(directory, nativeObserverManifestName), 'utf8'))).toEqual(
      result
    );
  }
);

it('retains an actual snapshot original on ambiguous close and refuses another build before mutation', async () => {
  vi.resetModules();
  const { buildNativeObserver: isolatedBuild } =
    await import('../../scripts/build-native-observer.js');
  const mockedOpen = vi.mocked(fsPromises.open);
  const actualOpen = mockedOpen.getMockImplementation()!;
  let closeCalls = 0;
  let original: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  mockedOpen.mockImplementationOnce(async (...args) => {
    original = await actualOpen(...args);
    const actualClose = original.close.bind(original);
    vi.spyOn(original, 'close').mockImplementation(async () => {
      closeCalls++;
      await actualClose();
      throw new Error('injected ambiguous snapshot close');
    });
    return original;
  });
  try {
    await expect(isolatedBuild({ outputDirectory: directory, platform: 'linux' })).rejects.toThrow(
      'injected ambiguous snapshot close'
    );
    expect(original).toBeDefined();
    expect(closeCalls).toBe(1);
    const opens = mockedOpen.mock.calls.length;
    const next = join(directory, 'must-not-be-created');
    await expect(isolatedBuild({ outputDirectory: next, platform: 'linux' })).rejects.toThrow(
      'NATIVE_ASSET_CLOSE_UNCERTAIN'
    );
    expect(mockedOpen.mock.calls.length).toBe(opens);
    expect(closeCalls).toBe(1);
    await expect(stat(next)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    mockedOpen.mockImplementation(actualOpen);
    vi.restoreAllMocks();
  }
});

it.skipIf(process.platform !== 'darwin')(
  'preserves actual parent lifetime across reparenting while refusing changed child relationships',
  async () => {
    const control = join(directory, 'children-control.c');
    const binary = join(directory, 'children-control');
    const source = new URL('../runtime/native/darwin-process-observer.c', import.meta.url);
    const headerDirectory = new URL('../runtime/native/', import.meta.url);
    await writeFile(
      control,
      `
#include "darwin-process-observer.h"
#include <libproc.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
static int scenario, parent_reads, child_reads;
pid_t control_getpid(void) { return 900; }
pid_t control_getppid(void) { return 899; }
int control_sysctl(int *name, u_int count, void *old, size_t *bytes, void *new_value, size_t new_bytes) {
  (void)name; (void)count; (void)new_value; (void)new_bytes;
  struct timeval value = { 1000, 20 }; memcpy(old, &value, sizeof(value)); *bytes = sizeof(value); return 0;
}
int control_listpids(uint32_t type, uint32_t parent, void *buffer, int capacity) {
  if (type != PROC_PPID_ONLY || parent != 42 || capacity < (int)sizeof(pid_t)) return -1;
  const pid_t child = 43; memcpy(buffer, &child, sizeof(child)); return sizeof(child);
}
int control_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int capacity) {
  if (flavor != PROC_PIDTBSDINFO || arg != 1 || capacity != sizeof(struct proc_bsdinfo)) return -1;
  struct proc_bsdinfo value; memset(&value, 0, sizeof(value));
  value.pbi_pid = pid; value.pbi_status = SSLEEP; value.pbi_start_tvsec = pid * 10; value.pbi_start_tvusec = 5;
  if (pid == 42) {
    value.pbi_ppid = parent_reads++ ? 1 : 100;
    if (scenario == 1 && parent_reads == 2) value.pbi_start_tvsec++;
  } else if (pid == 43) {
    value.pbi_ppid = 42; child_reads++;
    if (scenario == 2 && child_reads == 2) value.pbi_ppid = 99;
    if (scenario == 3 && child_reads == 2) value.pbi_start_tvusec++;
  } else return -1;
  memcpy(buffer, &value, sizeof(value)); return sizeof(value);
}
int main(void) {
  for (scenario = 0; scenario < 4; scenario++) {
    parent_reads = child_reads = 0; struct dorkos_darwin_children result;
    if (dorkos_darwin_children(42, &result)) return 2;
    printf("%d %d %d %d %d\\n", scenario, result.complete, result.parent_before.parent_pid,
      result.parent_after.parent_pid, result.batch.processes[0].kind);
  }
  return 0;
}
`
    );
    // Link the actual production core; only its OS observations are substituted.
    // This does not duplicate its lifetime or completeness decisions in the test.
    execFileSync(
      '/usr/bin/xcrun',
      [
        '--sdk',
        'macosx',
        'clang',
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DDORKOS_DARWIN_OBSERVER_NO_MAIN',
        '-Dproc_pidinfo=control_pidinfo',
        '-Dproc_listpids=control_listpids',
        '-Dsysctl=control_sysctl',
        '-Dgetpid=control_getpid',
        '-Dgetppid=control_getppid',
        '-I',
        fileURLToPath(headerDirectory),
        fileURLToPath(source),
        control,
        '-o',
        binary,
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 }
    );
    expect(
      execFileSync(binary, [], { encoding: 'utf8', maxBuffer: 8192 }).trim().split('\n')
    ).toEqual([
      '0 1 100 1 0', // Stable original parent can move to launchd; its child relation still holds.
      '1 0 100 1 0', // A different parent birth cannot certify the same parent lifetime.
      '2 0 100 1 2', // The child's current parent must match on both observations.
      '3 0 100 1 2', // A child lifetime change is unknown, even with unchanged PID sets.
    ]);
  }
);

it.skipIf(process.platform !== 'darwin')(
  'retains actual native inspect refusal origin without changing its unknown outcome',
  async () => {
    const control = join(directory, 'inspect-transition-control.c');
    const binary = join(directory, 'inspect-transition-control');
    const source = new URL('../runtime/native/darwin-process-observer.c', import.meta.url);
    const headerDirectory = new URL('../runtime/native/', import.meta.url);
    await writeFile(
      control,
      `
#include "darwin-process-observer.h"
#include <libproc.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/time.h>
#include <string.h>
#include <stdio.h>
static int scenario, reads, lists;
int control_sysctl(int *name, unsigned int count, void *old, size_t *bytes, void *new_value, size_t new_bytes) {
  (void)name; (void)count; (void)new_value; (void)new_bytes;
  struct timeval value = { 1000, 20 }; memcpy(old, &value, sizeof(value)); *bytes = sizeof(value); return 0;
}
int control_listpids(uint32_t type, uint32_t parent, void *buffer, int capacity) {
  (void)parent;
  if (type != PROC_ALL_PIDS || capacity < 2 * (int)sizeof(pid_t)) return -1;
  int absent = (scenario == 5 || scenario == 7) ? lists == 1 : (scenario == 6 && lists == 0) || scenario == 8;
  lists++;
  const pid_t pids[2] = { absent ? 99 : 42, 100 }; memcpy(buffer, pids, sizeof(pids)); return sizeof(pids);
}
int control_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int capacity) {
  if (pid != 42 || flavor != PROC_PIDTBSDINFO || arg != 1 || capacity != (int)sizeof(struct proc_bsdinfo)) return -1;
  struct proc_bsdinfo value; memset(&value, 0, sizeof(value));
  value.pbi_pid = pid; value.pbi_ppid = 10; value.pbi_status = SSLEEP;
  value.pbi_start_tvsec = 100; value.pbi_start_tvusec = 5;
  if (scenario == 4 && reads == 0) value.pbi_status = SZOMB;
  if (reads == 1) {
    if (scenario == 1 || scenario == 7) value.pbi_start_tvusec++;
    if (scenario == 2) value.pbi_ppid++;
    if (scenario == 3) value.pbi_status = SZOMB;
  }
  reads++; memcpy(buffer, &value, sizeof(value)); return sizeof(value);
}
int main(void) {
  const pid_t pid = 42;
  for (scenario = 0; scenario < 9; scenario++) {
    reads = lists = 0; struct dorkos_darwin_batch result;
    if (dorkos_darwin_inspect(&pid, 1, &result)) return 2;
    printf("%d %d %d %d %d %d\\n", scenario, result.processes[0].kind,
      result.processes[0].uncertainty, result.processes[0].error, reads, lists);
  }
  return 0;
}
`
    );
    execFileSync(
      '/usr/bin/xcrun',
      [
        '--sdk',
        'macosx',
        'clang',
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DDORKOS_DARWIN_OBSERVER_NO_MAIN',
        '-Dproc_pidinfo=control_pidinfo',
        '-Dproc_listpids=control_listpids',
        '-Dsysctl=control_sysctl',
        '-I',
        fileURLToPath(headerDirectory),
        fileURLToPath(source),
        control,
        '-o',
        binary,
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 }
    );
    expect(
      execFileSync(binary, [], { encoding: 'utf8', maxBuffer: 8192 }).trim().split('\n')
    ).toEqual([
      '0 0 0 0 2 2',
      '1 2 1 35 2 2',
      '2 2 2 35 2 2',
      '3 2 3 35 2 2',
      '4 2 4 35 2 2',
      '5 2 5 35 2 2',
      '6 2 6 35 2 2',
      '7 2 5 35 2 2',
      '8 2 7 35 2 2',
    ]);
  }
);
