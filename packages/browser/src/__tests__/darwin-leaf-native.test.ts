import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { parseDarwinChildrenBatch } from '../runtime/darwin-process-observer.js';
it.skipIf(process.platform !== 'darwin')(
  'uses actual native enrollment reads and NOTE_EXIT/NOTE_FORK decision sites',
  async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'leaf-events-control-'));
    onTestFinished(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const source = fileURLToPath(
      new URL('../runtime/native/darwin-process-observer.c', import.meta.url)
    );
    const control = join(directory, 'control.c');
    const binary = join(directory, 'control');
    await writeFile(
      control,
      `
#define main observer_original_main
#define proc_pidinfo control_pidinfo
#define proc_listpids control_listpids
#define sysctl control_sysctl
#define kevent control_kevent
#define kqueue control_kqueue
#include ${JSON.stringify(source)}
#undef main
static int scenario, reads, censuses, registrations, drains;
int control_kqueue(void) { return 9; }
int control_sysctl(int *name, u_int length, void *out, size_t *bytes, void *input, size_t input_bytes) {
  (void)name; (void)length; (void)input; (void)input_bytes;
  if (*bytes != sizeof(struct timeval)) return -1;
  if (scenario == 9) { errno = EPERM; return -1; }
  struct timeval *boot = out; boot->tv_sec = 1; boot->tv_usec = 0; return 0;
}
int control_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
  (void)flavor; (void)arg;
  if (size != (int)sizeof(struct proc_bsdinfo)) return -1;
  struct proc_bsdinfo *value = buffer; memset(value, 0, sizeof(*value));
  value->pbi_pid = (uint32_t)pid; value->pbi_ppid = pid == 42 ? 7 : 42;
  value->pbi_start_tvsec = pid == 42 ? 10 : 12; value->pbi_start_tvusec = 2; value->pbi_status = SRUN;
  if (pid == 42) {
    reads++;
    if (scenario == 3 && reads == 4) value->pbi_start_tvsec++;
    if (scenario == 6 && reads == 1) { errno = ESRCH; return 0; }
  }
  return size;
}
int control_listpids(uint32_t flavor, uint32_t pid, void *buffer, int size) {
  (void)flavor; (void)pid; (void)size; censuses++;
  if (scenario == 2) { ((pid_t *)buffer)[0] = 30; return (int)sizeof(pid_t); }
  return 0;
}
int control_kevent(int queue, const struct kevent *changes, int nchanges, struct kevent *events, int capacity, const struct timespec *timeout) {
  (void)queue; (void)capacity; (void)timeout;
  if (nchanges) {
    if (changes[0].filter != EVFILT_PROC || changes[0].fflags != (NOTE_EXIT | NOTE_FORK)) return -1;
    registrations++; memset(events, 0, sizeof(*events)); events[0].flags = EV_ERROR;
    if (scenario == 7) events[0].data = EPERM;
    return 1;
  }
  drains++;
  if (scenario == 8) return DORKOS_DARWIN_REQUEST_MAX;
  if (scenario == 4 || scenario == 5) {
    EV_SET(events, 42, EVFILT_PROC, scenario == 5 ? EV_ERROR : 0, NOTE_FORK, 0, (void *)(uintptr_t)1); return 1;
  }
  return 0;
}
int main(void) {
  for (scenario = 0; scenario < 10; scenario++) {
    struct leaf_receiver owner; memset(&owner, 0, sizeof(owner)); owner.queue = 9;
    reads = censuses = registrations = drains = 0;
    const int result = leaf_command(&owner, "W 1 42 10 2 1 0");
    if (!result && (scenario == 0 || scenario == 1)) {
      struct kevent event;
      EV_SET(&event, 42, EVFILT_PROC, 0, scenario == 1 ? NOTE_FORK : NOTE_EXIT, 0, (void *)(uintptr_t)1);
      if (leaf_events(&owner, &event, 1)) return 2;
      if (scenario == 1) {
        struct dorkos_darwin_children later;
        if (dorkos_darwin_children(42, &later) || !later.complete || later.batch.count || !owner.watches[0].dirty) return 3;
        EV_SET(&event, 42, EVFILT_PROC, 0, NOTE_EXIT, 0, (void *)(uintptr_t)1);
        if (leaf_events(&owner, &event, 1)) return 4;
      }
    }
    printf("CASE %d %d %d %d %d %d %d %d\\n", scenario, result, owner.watches[0].admitted, owner.watches[0].dirty, owner.watches[0].exited, reads, censuses, registrations);
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
        control,
        '-lproc',
        '-o',
        binary,
      ],
      { maxBuffer: 256 * 1024 }
    );
    const rows = execFileSync(binary, [], { encoding: 'utf8', maxBuffer: 256 * 1024 })
      .trim()
      .split('\n');
    expect(rows.filter((row) => row.startsWith('CASE '))).toEqual([
      'CASE 0 0 1 0 1 4 2 1', // One complete zero baseline after original registration; final NOTE_EXIT.
      'CASE 1 0 1 1 1 6 4 1', // Fork -> reparented child -> genuine zero census -> exit remains dirty.
      'CASE 2 0 0 0 0 4 2 1', // Non-leaf cannot produce a terminal-leaf capability.
      'CASE 3 0 0 0 0 4 2 1', // Changed final birth refuses original watch.
      'CASE 4 0 0 1 0 4 2 1', // Fork queued during enrollment prevents initial admission.
      'CASE 5 5 0 0 0 4 2 1', // Native tracking error is uncertainty, never exit.
      'CASE 6 0 0 0 0 1 0 0', // Failed initial positive read never enters registration.
      'CASE 7 0 0 0 0 1 0 1', // Unsupported/permission registration never admits a watch.
      'CASE 8 5 0 0 0 4 2 1', // Full native event batch is refused, not silently truncated.
      'CASE 9 0 0 0 0 2 0 1', // Entered original census boot failure cannot supply a baseline.
    ]);
    for (const [scenario, expected] of [
      [2, 'nonleaf'],
      [3, 'refused'],
      [4, 'refused'],
      [9, 'refused'],
    ] as const) {
      const end = rows.findIndex((row) => row.startsWith(`CASE ${scenario} `));
      const start = rows.findIndex((row) => row.startsWith(`CASE ${scenario - 1} `));
      expect(rows.slice(start + 1, end)).toContain(
        `{"kind":"watch","slot":1,"result":"${expected}"}`
      );
    }
    const baselines = rows
      .filter((row) => row.startsWith('{"kind":"baseline"'))
      .map((row) => {
        const envelope: unknown = JSON.parse(row);
        if (!envelope || typeof envelope !== 'object' || !('batch' in envelope))
          throw new Error('original-native-baseline-missing');
        return parseDarwinChildrenBatch(Buffer.from(JSON.stringify(envelope.batch)), {
          pid: 42,
          birth: 'darwin-bsd-start:10:2',
        });
      });
    expect(
      baselines.some(
        (batch) =>
          batch.complete &&
          batch.processes.some(
            (fact) => fact.kind === 'present' && fact.identity.pid === 30 && fact.parentPid === 42
          )
      )
    ).toBe(true);
    expect(baselines.some((batch) => batch.complete && batch.processes.length === 0)).toBe(true);
    expect(rows).toContain('{"kind":"event","slot":1,"result":"exit"}');
    expect(rows).toContain('{"kind":"event","slot":1,"result":"fork"}');
  }
);
