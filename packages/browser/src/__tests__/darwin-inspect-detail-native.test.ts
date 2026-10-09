import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { parseDarwinProcessBatch } from '../runtime/darwin-process-observer.js';

// Actual C decision sites with controlled original OS reads; not real process-exit acceptance.
it.skipIf(process.platform !== 'darwin')(
  'retains original C membership and double-read details without healing unknown',
  async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'inspect-detail-control-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const source = fileURLToPath(
      new URL('../runtime/native/darwin-process-observer.c', import.meta.url)
    );
    const control = join(directory, 'control.c'),
      binary = join(directory, 'control');
    await writeFile(
      control,
      `
#define main original_observer_main
#define proc_pidinfo control_pidinfo
#define proc_listpids control_listpids
#define sysctl control_sysctl
#include ${JSON.stringify(source)}
#undef main
static int scenario, reads, censuses;
int control_sysctl(int *name, u_int length, void *out, size_t *bytes, void *input, size_t input_bytes) {
  (void)name; (void)length; (void)input; (void)input_bytes;
  if (*bytes != sizeof(struct timeval)) return -1;
  struct timeval *boot = out; boot->tv_sec = 1; boot->tv_usec = 0; return 0;
}
int control_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
  (void)flavor; (void)arg; reads++;
  if (scenario == 1 && reads == 2) { errno = ESRCH; return 0; }
  if (scenario == 2) { errno = EPERM; return 0; }
  if (size != (int)sizeof(struct proc_bsdinfo)) return -1;
  struct proc_bsdinfo *value = buffer; memset(value, 0, sizeof(*value));
  value->pbi_pid = pid; value->pbi_ppid = 7; value->pbi_status = SRUN;
  value->pbi_start_tvsec = 10 + (scenario == 3 && reads == 2); value->pbi_start_tvusec = 2;
  return size;
}
int control_listpids(uint32_t flavor, uint32_t pid, void *buffer, int size) {
  (void)flavor; (void)pid; (void)size; censuses++;
  ((pid_t *)buffer)[0] = censuses == 1 && scenario != 2 ? 42 : 99;
  return sizeof(pid_t);
}
int main(void) {
  for (scenario = 0; scenario < 4; scenario++) {
    reads = censuses = 0;
    pid_t pid = 42; struct dorkos_darwin_batch batch;
    if (dorkos_darwin_inspect(&pid, 1, &batch)) return 2;
    if (reads != 2 || censuses != 2 || batch.processes[0].kind != DORKOS_DARWIN_UNKNOWN) return 3;
    if (print_reply(&batch, NULL)) return 4;
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
    expect(rows).toHaveLength(4);
    const facts = rows.map((row) => parseDarwinProcessBatch(Buffer.from(row), [42]).processes[0]);
    expect(facts).toMatchObject([
      {
        kind: 'unknown',
        uncertainty: 'membership-disappeared',
        inspection: {
          membershipBefore: true,
          membershipAfter: false,
          firstError: 0,
          secondError: 0,
          birthChanged: false,
        },
      },
      {
        kind: 'unknown',
        uncertainty: 'membership-disappeared',
        inspection: {
          firstError: 0,
          secondError: 3,
          firstZombie: false,
          secondZombie: null,
          birthChanged: null,
        },
      },
      {
        kind: 'unknown',
        error: 1,
        inspection: {
          membershipBefore: false,
          membershipAfter: false,
          firstError: 1,
          secondError: 1,
        },
      },
      {
        kind: 'unknown',
        uncertainty: 'membership-disappeared',
        inspection: { birthChanged: true },
      },
    ]);
  }
);
