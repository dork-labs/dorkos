#include "darwin-process-observer.h"

#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <unistd.h>

struct pid_list { pid_t *pids; size_t count; };

static int compare_pid(const void *a, const void *b) {
  const pid_t left = *(const pid_t *)a, right = *(const pid_t *)b;
  return (left > right) - (left < right);
}

static int boot_time(struct timeval *value) {
  int mib[] = { CTL_KERN, KERN_BOOTTIME };
  size_t bytes = sizeof(*value);
  memset(value, 0, sizeof(*value)); errno = 0;
  if (sysctl(mib, 2, value, &bytes, NULL, 0) != 0) return errno ? errno : EIO;
  if (bytes != sizeof(*value) || value->tv_sec <= 0 || value->tv_usec < 0 || value->tv_usec >= 1000000)
    return EIO;
  return 0;
}

static int list_pids(struct pid_list *list) {
  const size_t capacity = DORKOS_DARWIN_ENUMERATION_MAX;
  const int bytes = (int)(capacity * sizeof(pid_t));
  errno = 0;
  /* Apple XNU's PROC_ALL_PIDS walks both allproc and zombproc. A full
   * buffer may have been truncated and is refused, not treated as complete. */
  const int got = proc_listpids(PROC_ALL_PIDS, 0, list->pids, bytes);
  if (got <= 0) return errno ? errno : EIO;
  if (got >= bytes || got % (int)sizeof(pid_t) != 0) return EOVERFLOW;
  list->count = (size_t)got / sizeof(pid_t);
  qsort(list->pids, list->count, sizeof(pid_t), compare_pid);
  for (size_t i = 0; i < list->count; i++) {
    if (list->pids[i] < 0 || (i && list->pids[i] == list->pids[i - 1])) return EIO;
  }
  return 0;
}

static int listed(const struct pid_list *list, pid_t pid) {
  return bsearch(&pid, list->pids, list->count, sizeof(pid_t), compare_pid) != NULL;
}

static int read_process(pid_t pid, struct proc_bsdinfo *value) {
  memset(value, 0, sizeof(*value)); errno = 0;
  /* arg=1 explicitly includes zombies in PROC_PIDTBSDINFO. arg=0 would
   * make a retained zombie look like ESRCH. Neither error proves absence. */
  const int got = proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, value, (int)sizeof(*value));
  if (got != (int)sizeof(*value)) return errno ? errno : EIO;
  if (value->pbi_pid != (uint32_t)pid || value->pbi_ppid > INT_MAX ||
      !value->pbi_start_tvsec || value->pbi_start_tvusec >= 1000000 ||
      value->pbi_status < SIDL || value->pbi_status > SZOMB) return EIO;
  return 0;
}

int dorkos_darwin_inspect(const pid_t *pids, size_t count, struct dorkos_darwin_batch *batch) {
  if (!pids || !batch || !count || count > DORKOS_DARWIN_REQUEST_MAX) return EINVAL;
  for (size_t i = 0; i < count; i++) {
    if (pids[i] < 1) return EINVAL;
    for (size_t j = 0; j < i; j++) if (pids[i] == pids[j]) return EINVAL;
  }
  memset(batch, 0, sizeof(*batch));
  int absence_eligible[DORKOS_DARWIN_REQUEST_MAX] = { 0 };
  struct timeval before_boot, after_boot;
  int error = boot_time(&before_boot);
  if (error) return error;
  struct pid_list before = { calloc(DORKOS_DARWIN_ENUMERATION_MAX, sizeof(pid_t)), 0 };
  struct pid_list after = { calloc(DORKOS_DARWIN_ENUMERATION_MAX, sizeof(pid_t)), 0 };
  if (!before.pids || !after.pids) { free(before.pids); free(after.pids); return ENOMEM; }
  error = list_pids(&before);
  if (error) goto done;
  batch->count = count;
  for (size_t i = 0; i < count; i++) {
    struct dorkos_darwin_process *fact = &batch->processes[i];
    struct proc_bsdinfo first, second;
    fact->pid = pids[i]; fact->kind = DORKOS_DARWIN_UNKNOWN;
    const int first_error = read_process(pids[i], &first);
    const int second_error = read_process(pids[i], &second);
    absence_eligible[i] = first_error == ESRCH && second_error == ESRCH;
    if (first_error || second_error) { fact->error = first_error ? first_error : second_error; continue; }
    if (first.pbi_start_tvsec != second.pbi_start_tvsec || first.pbi_start_tvusec != second.pbi_start_tvusec ||
        first.pbi_ppid != second.pbi_ppid || (first.pbi_status == SZOMB) != (second.pbi_status == SZOMB)) {
      fact->uncertainty = (first.pbi_start_tvsec != second.pbi_start_tvsec || first.pbi_start_tvusec != second.pbi_start_tvusec)
        ? DORKOS_DARWIN_BIRTH_CHANGED : first.pbi_ppid != second.pbi_ppid
          ? DORKOS_DARWIN_PARENT_CHANGED : second.pbi_status == SZOMB
            ? DORKOS_DARWIN_ALIVE_TO_ZOMBIE : DORKOS_DARWIN_ZOMBIE_TO_ALIVE;
      fact->error = EAGAIN; continue;
    }
    fact->kind = DORKOS_DARWIN_PRESENT;
    fact->seconds = first.pbi_start_tvsec; fact->microseconds = first.pbi_start_tvusec;
    fact->parent_pid = (pid_t)first.pbi_ppid; fact->zombie = first.pbi_status == SZOMB;
  }
  error = list_pids(&after);
  if (error) goto done;
  error = boot_time(&after_boot);
  if (error) goto done;
  if (before_boot.tv_sec != after_boot.tv_sec || before_boot.tv_usec != after_boot.tv_usec) {
    error = EAGAIN; goto done;
  }
  batch->boot_seconds = (uint64_t)before_boot.tv_sec;
  batch->boot_microseconds = (uint64_t)before_boot.tv_usec;
  for (size_t i = 0; i < count; i++) {
    struct dorkos_darwin_process *fact = &batch->processes[i];
    const int seen_before = listed(&before, fact->pid), seen_after = listed(&after, fact->pid);
    if (!seen_before && !seen_after && fact->kind != DORKOS_DARWIN_PRESENT) {
      /* ESRCH alone is not used. Other query errors (e.g. permission denial)
       * remain unknown even when the PID was missing from the sampled lists. */
      if (absence_eligible[i]) { fact->kind = DORKOS_DARWIN_ABSENT; fact->error = 0; }
    } else if (!seen_before || !seen_after) {
      fact->kind = DORKOS_DARWIN_UNKNOWN; fact->error = EAGAIN;
      /* This final membership refusal supersedes any earlier per-read disagreement. */
      fact->uncertainty = seen_before ? DORKOS_DARWIN_MEMBERSHIP_DISAPPEARED : seen_after
        ? DORKOS_DARWIN_MEMBERSHIP_APPEARED : DORKOS_DARWIN_MEMBERSHIP_ABSENT_WITH_PRESENT_READS;
    }
  }
done:
  free(before.pids); free(after.pids);
  if (error) memset(batch, 0, sizeof(*batch));
  return error;
}

static void parent_fact(const struct proc_bsdinfo *value, struct dorkos_darwin_process *fact) {
  fact->pid = (pid_t)value->pbi_pid; fact->kind = DORKOS_DARWIN_PRESENT;
  fact->seconds = value->pbi_start_tvsec; fact->microseconds = value->pbi_start_tvusec;
  fact->parent_pid = (pid_t)value->pbi_ppid; fact->zombie = value->pbi_status == SZOMB;
}

static int child_pids(pid_t parent, pid_t *pids, size_t *count) {
  const int capacity = DORKOS_DARWIN_REQUEST_MAX + 2;
  errno = 0;
  /* Use the byte-returning API explicitly. PROC_PPID_ONLY also walks zombies;
   * traced historical-parent matches are later checked against current ppid. */
  const int got = proc_listpids(PROC_PPID_ONLY, (uint32_t)parent, pids, capacity * (int)sizeof(pid_t));
  if (got < 0 || (got == 0 && errno)) return errno ? errno : EIO;
  if (got >= capacity * (int)sizeof(pid_t) || got % (int)sizeof(pid_t)) return EOVERFLOW;
  *count = (size_t)got / sizeof(pid_t);
  qsort(pids, *count, sizeof(pid_t), compare_pid);
  for (size_t i = 0; i < *count; i++)
    if (pids[i] <= 0 || (i && pids[i] == pids[i - 1])) return EIO;
  // This exact helper is the caller's owned observation auxiliary, not a
  // browser descendant. No other PID, command name or lifetime is excluded.
  if (parent == getppid()) {
    for (size_t i = 0; i < *count; i++) if (pids[i] == getpid()) {
      memmove(pids + i, pids + i + 1, (*count - i - 1) * sizeof(pid_t));
      --*count; break;
    }
  }
  if (*count > DORKOS_DARWIN_REQUEST_MAX) return EOVERFLOW;
  return 0;
}

int dorkos_darwin_children(pid_t parent, struct dorkos_darwin_children *result) {
  if (parent <= 0 || !result) return EINVAL;
  memset(result, 0, sizeof(*result));
  struct timeval before_boot, after_boot;
  int error = boot_time(&before_boot);
  if (error) return error;
  struct proc_bsdinfo before_parent, after_parent;
  result->have_parent_before = read_process(parent, &before_parent) == 0;
  if (result->have_parent_before) parent_fact(&before_parent, &result->parent_before);
  pid_t before[DORKOS_DARWIN_REQUEST_MAX + 2], after[DORKOS_DARWIN_REQUEST_MAX + 2];
  size_t before_count = 0, after_count = 0;
  const int before_error = child_pids(parent, before, &before_count);
  int complete = result->have_parent_before && !result->parent_before.zombie && !before_error;
  if (!before_error) {
    result->batch.count = before_count;
    for (size_t i = 0; i < before_count; i++) {
      struct dorkos_darwin_process *fact = &result->batch.processes[i];
      struct proc_bsdinfo first, second;
      fact->pid = before[i]; fact->kind = DORKOS_DARWIN_UNKNOWN;
      const int first_error = read_process(before[i], &first), second_error = read_process(before[i], &second);
      if (first_error || second_error) {
        fact->error = first_error ? first_error : second_error; complete = 0; continue;
      }
      if (first.pbi_start_tvsec != second.pbi_start_tvsec || first.pbi_start_tvusec != second.pbi_start_tvusec ||
          first.pbi_ppid != (uint32_t)parent || second.pbi_ppid != (uint32_t)parent ||
          (first.pbi_status == SZOMB) != (second.pbi_status == SZOMB)) {
        fact->error = EAGAIN; complete = 0; continue;
      }
      parent_fact(&second, fact);
    }
  }
  const int after_error = child_pids(parent, after, &after_count);
  if (before_error || after_error || before_count != after_count ||
      memcmp(before, after, before_count * sizeof(pid_t))) complete = 0;
  result->have_parent_after = read_process(parent, &after_parent) == 0;
  if (result->have_parent_after) parent_fact(&after_parent, &result->parent_after);
  /* The retained parent may reparent after its manager dies. Its own ppid is
   * not the parent-to-child relationship sampled above; only its lifetime
   * and zombie status must remain valid around enumeration. */
  if (!result->have_parent_before || !result->have_parent_after || result->parent_after.zombie ||
      before_parent.pbi_start_tvsec != after_parent.pbi_start_tvsec ||
      before_parent.pbi_start_tvusec != after_parent.pbi_start_tvusec)
    complete = 0;
  error = boot_time(&after_boot);
  if (error) return error;
  if (before_boot.tv_sec != after_boot.tv_sec || before_boot.tv_usec != after_boot.tv_usec) return EAGAIN;
  result->batch.boot_seconds = (uint64_t)before_boot.tv_sec;
  result->batch.boot_microseconds = (uint64_t)before_boot.tv_usec;
  result->complete = complete;
  return 0;
}

#ifndef DORKOS_DARWIN_OBSERVER_NO_MAIN
static void print_identity(const struct dorkos_darwin_process *fact) {
  printf("{\"pid\":%d,\"seconds\":\"%" PRIu64 "\",\"microseconds\":\"%" PRIu64 "\"}",
    fact->pid, fact->seconds, fact->microseconds);
}
int main(int argc, char **argv) {
  if (argc < 3 || argc > DORKOS_DARWIN_REQUEST_MAX + 2 ||
      (strcmp(argv[1], "inspect") && strcmp(argv[1], "children"))) return 2;
  const int children = !strcmp(argv[1], "children");
  if (children && argc != 3) return 2;
  pid_t pids[DORKOS_DARWIN_REQUEST_MAX];
  for (int i = 2; i < argc; i++) {
    if (!argv[i][0]) return 2;
    for (const char *c = argv[i]; *c; c++) if (*c < '0' || *c > '9') return 2;
    char *end; errno = 0; const unsigned long value = strtoul(argv[i], &end, 10);
    if (errno || *end || !value || value > INT_MAX) return 2;
    pids[i - 2] = (pid_t)value;
  }
  struct dorkos_darwin_batch batch;
  struct dorkos_darwin_children result;
  const int error = children ? dorkos_darwin_children(pids[0], &result) : dorkos_darwin_inspect(pids, (size_t)argc - 2, &batch);
  if (error) { fprintf(stderr, "Darwin observation unavailable: %d\n", error); return 1; }
  if (children) batch = result.batch;
  printf("{\"version\":1,\"bootSeconds\":\"%" PRIu64 "\",\"bootMicroseconds\":\"%" PRIu64 "\"",
    batch.boot_seconds, batch.boot_microseconds);
  if (children) {
    printf(",\"parentBefore\":");
    if (result.have_parent_before) print_identity(&result.parent_before); else printf("null");
    printf(",\"parentAfter\":");
    if (result.have_parent_after) print_identity(&result.parent_after); else printf("null");
    printf(",\"complete\":%s", result.complete ? "true" : "false");
  }
  printf(",\"processes\":[");
  for (size_t i = 0; i < batch.count; i++) {
    const struct dorkos_darwin_process *fact = &batch.processes[i];
    if (i) putchar(',');
    if (fact->kind == DORKOS_DARWIN_PRESENT)
      printf("{\"kind\":\"present\",\"identity\":{\"pid\":%d,\"seconds\":\"%" PRIu64 "\",\"microseconds\":\"%" PRIu64
        "\"},\"parentPid\":%d,\"zombie\":%s}", fact->pid, fact->seconds, fact->microseconds, fact->parent_pid, fact->zombie ? "true" : "false");
    else if (fact->kind == DORKOS_DARWIN_ABSENT) printf("{\"kind\":\"absent\",\"pid\":%d}", fact->pid);
    else {
      const char *reason = NULL;
      switch (fact->uncertainty) {
        case DORKOS_DARWIN_BIRTH_CHANGED: reason = "birth-changed"; break;
        case DORKOS_DARWIN_PARENT_CHANGED: reason = "parent-changed"; break;
        case DORKOS_DARWIN_ALIVE_TO_ZOMBIE: reason = "alive-to-zombie"; break;
        case DORKOS_DARWIN_ZOMBIE_TO_ALIVE: reason = "zombie-to-alive"; break;
        case DORKOS_DARWIN_MEMBERSHIP_DISAPPEARED: reason = "membership-disappeared"; break;
        case DORKOS_DARWIN_MEMBERSHIP_APPEARED: reason = "membership-appeared"; break;
        case DORKOS_DARWIN_MEMBERSHIP_ABSENT_WITH_PRESENT_READS: reason = "membership-absent-with-present-reads"; break;
        default: break;
      }
      printf("{\"kind\":\"unknown\",\"pid\":%d,\"error\":%d", fact->pid, fact->error);
      if (reason) printf(",\"uncertainty\":\"%s\"", reason);
      putchar('}');
    }
  }
  puts("]}");
  return ferror(stdout) ? 1 : 0;
}
#endif
