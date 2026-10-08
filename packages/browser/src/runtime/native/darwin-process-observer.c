#include "darwin-process-observer.h"

#include <errno.h>
#include <fcntl.h>
#include <sys/event.h>
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
    fact->have_inspect_observation = 1;
    fact->first_error = first_error; fact->second_error = second_error;
    fact->first_zombie = first_error ? -1 : first.pbi_status == SZOMB;
    fact->second_zombie = second_error ? -1 : second.pbi_status == SZOMB;
    fact->birth_changed = first_error || second_error ? -1 :
      first.pbi_start_tvsec != second.pbi_start_tvsec || first.pbi_start_tvusec != second.pbi_start_tvusec;
    fact->parent_changed = first_error || second_error ? -1 : first.pbi_ppid != second.pbi_ppid;
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
    fact->membership_before = seen_before; fact->membership_after = seen_after;
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
  result->parent_before_error = read_process(parent, &before_parent);
  result->have_parent_before = result->parent_before_error == 0;
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
  result->parent_after_error = read_process(parent, &after_parent);
  result->have_parent_after = result->parent_after_error == 0;
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
/* A single retained receiver watches only explicitly censused original leaves.
 * NOTE_FORK has no child identity: once observed it permanently disqualifies
 * this watch. NOTE_EXIT is terminal evidence, never a reap/absence assertion. */
struct leaf_watch {
  pid_t pid;
  int assigned, admitted, dirty, exited;
};
struct leaf_receiver {
  int queue;
  struct leaf_watch watches[DORKOS_DARWIN_REQUEST_MAX];
};
static int leaf_publish(const char *kind, unsigned slot, const char *result) {
  if (printf("{\"kind\":\"%s\",\"slot\":%u,\"result\":\"%s\"}\n", kind, slot, result) < 0 || fflush(stdout)) return EIO;
  return 0;
}
static int leaf_events(struct leaf_receiver *owner, struct kevent *events, int count) {
  for (int i = 0; i < count; i++) {
    struct kevent *event = &events[i];
    if (event->filter == EVFILT_READ && event->ident == STDIN_FILENO) continue;
    const uintptr_t slot = (uintptr_t)event->udata;
    if (event->filter != EVFILT_PROC || slot < 1 || slot > DORKOS_DARWIN_REQUEST_MAX ||
        (event->flags & EV_ERROR) || !(event->fflags & (NOTE_EXIT | NOTE_FORK)) ||
        (event->fflags & ~(NOTE_EXIT | NOTE_FORK))) return EIO;
    struct leaf_watch *watch = &owner->watches[slot - 1];
    if (!watch->assigned || event->ident != (uintptr_t)watch->pid) return EIO;
    if ((event->fflags & NOTE_FORK) && !watch->dirty) {
      watch->dirty = 1;
      if (leaf_publish("event", (unsigned)slot, "fork")) return EIO;
    }
    if ((event->fflags & NOTE_EXIT) && !watch->exited) {
      watch->exited = 1;
      if (leaf_publish("event", (unsigned)slot, "exit")) return EIO;
    }
  }
  return 0;
}
static int leaf_drain(struct leaf_receiver *owner) {
  struct kevent events[DORKOS_DARWIN_REQUEST_MAX];
  const struct timespec zero = { 0, 0 };
  /* One batch suffices for all 512 registered filters. A full batch is
   * conservatively refused rather than guessing an unobserved next batch. */
  const int count = kevent(owner->queue, NULL, 0, events, DORKOS_DARWIN_REQUEST_MAX, &zero);
  if (count < 0 || count == DORKOS_DARWIN_REQUEST_MAX) return EOVERFLOW;
  return leaf_events(owner, events, count);
}
static int print_reply_body(const struct dorkos_darwin_batch *, const struct dorkos_darwin_children *);

/* Closed original decision diagnostics only; the admitted result and native reads are unchanged. */
static int leaf_refused(unsigned slot, const char *reason, int error) {
  if (printf("{\"kind\":\"watch\",\"slot\":%u,\"result\":\"refused\",\"reason\":\"%s\",\"error\":%d}\n", slot, reason, error) < 0 || fflush(stdout)) return EIO;
  return 0;
}
static int leaf_command(struct leaf_receiver *owner, const char *line) {
  unsigned slot = 0;
  int used = 0, pid = 0;
  unsigned long long seconds = 0, microseconds = 0, boot_seconds = 0, boot_microseconds = 0;
  if (sscanf(line, "B %u%n", &slot, &used) == 1 && line[used] == '\0') {
    if (!slot || leaf_drain(owner)) return EIO;
    return leaf_publish("barrier", slot, "settled");
  }
  if (sscanf(line, "W %u %d %llu %llu %llu %llu%n", &slot, &pid, &seconds, &microseconds,
             &boot_seconds, &boot_microseconds, &used) != 6 || line[used] != '\0' ||
      slot < 1 || slot > DORKOS_DARWIN_REQUEST_MAX || pid < 1 || !seconds || microseconds >= 1000000 ||
      !boot_seconds || boot_microseconds >= 1000000) return EINVAL;
  struct leaf_watch *watch = &owner->watches[slot - 1];
  if (watch->assigned) return EINVAL;
  for (size_t i = 0; i < DORKOS_DARWIN_REQUEST_MAX; i++)
    if (owner->watches[i].assigned && owner->watches[i].pid == pid) return EINVAL;
  watch->assigned = 1; watch->pid = (pid_t)pid;
  struct proc_bsdinfo before, after;
  const int before_error = read_process((pid_t)pid, &before);
  if (before_error || before.pbi_status == SZOMB ||
      before.pbi_start_tvsec != seconds || before.pbi_start_tvusec != microseconds)
    return leaf_refused(slot, before_error ? "initial-read" : before.pbi_status == SZOMB ? "initial-zombie" : "initial-birth", before_error);
  struct kevent change, receipt;
  EV_SET(&change, (uintptr_t)pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_CLEAR | EV_RECEIPT,
         NOTE_EXIT | NOTE_FORK, 0, (void *)(uintptr_t)slot);
  const int registered = kevent(owner->queue, &change, 1, &receipt, 1, NULL);
  const int registration_error = registered < 0 ? (errno ? errno : EIO) : 0;
  if (registered != 1 || !(receipt.flags & EV_ERROR) || receipt.data != 0)
    return leaf_refused(slot, registered != 1 ? "registration-return" : !(receipt.flags & EV_ERROR) ? "registration-flags" : "registration-error", registered != 1 ? registration_error : (receipt.flags & EV_ERROR) && receipt.data > 0 && receipt.data <= INT_MAX ? (int)receipt.data : 0);
  /* Registration precedes the sole baseline census. Pending fork/exit events
   * are drained before publication. No later census can clear dirty. */
  struct dorkos_darwin_children census;
  const int error = dorkos_darwin_children((pid_t)pid, &census);
  const int after_error = read_process((pid_t)pid, &after);
  if (leaf_drain(owner)) return EIO;
  const int same = !after_error && after.pbi_status != SZOMB &&
    after.pbi_start_tvsec == seconds && after.pbi_start_tvusec == microseconds &&
    after.pbi_ppid == before.pbi_ppid;
  const int baseline_stable = !error && census.complete && same &&
    census.batch.boot_seconds == boot_seconds && census.batch.boot_microseconds == boot_microseconds &&
    census.parent_before.seconds == seconds && census.parent_before.microseconds == microseconds &&
    census.parent_after.seconds == seconds && census.parent_after.microseconds == microseconds &&
    census.parent_before.parent_pid == (pid_t)before.pbi_ppid &&
    census.parent_after.parent_pid == (pid_t)before.pbi_ppid &&
    !watch->dirty && !watch->exited;
  watch->admitted = baseline_stable && !census.batch.count;
  if (!error) {
    printf("{\"kind\":\"baseline\",\"slot\":%u,\"batch\":", slot);
    if (print_reply_body(&census.batch, &census)) return EIO;
    puts("}");
    if (fflush(stdout)) return EIO;
  }
  if (!baseline_stable) {
    const char *reason = error ? "census-error" : !census.complete ? "census-incomplete" :
      after_error ? "outer-read" : after.pbi_status == SZOMB ? "outer-zombie" :
      after.pbi_start_tvsec != seconds || after.pbi_start_tvusec != microseconds ? "outer-birth" :
      after.pbi_ppid != before.pbi_ppid ? "outer-parent" :
      census.batch.boot_seconds != boot_seconds || census.batch.boot_microseconds != boot_microseconds ? "boot" :
      census.parent_before.seconds != seconds || census.parent_before.microseconds != microseconds ||
      census.parent_after.seconds != seconds || census.parent_after.microseconds != microseconds ? "census-birth" :
      census.parent_before.parent_pid != (pid_t)before.pbi_ppid || census.parent_after.parent_pid != (pid_t)before.pbi_ppid ? "census-parent" :
      watch->dirty ? "fork" : "exit";
    return leaf_refused(slot, reason, error ? error : after_error);
  }
  return leaf_publish("watch", slot, watch->admitted ? "leaf" : "nonleaf");
}
static int watch_leaves(void) {
  struct leaf_receiver owner;
  memset(&owner, 0, sizeof(owner));
  owner.queue = kqueue();
  if (owner.queue < 0) return 1;
  const int flags = fcntl(STDIN_FILENO, F_GETFL);
  if (flags < 0 || fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) < 0) {
    (void)close(owner.queue); return 1;
  }
  struct kevent input;
  EV_SET(&input, STDIN_FILENO, EVFILT_READ, EV_ADD | EV_ENABLE, 0, 0, NULL);
  if (kevent(owner.queue, &input, 1, NULL, 0, NULL) < 0) { (void)close(owner.queue); return 1; }
  char line[256]; size_t retained = 0;
  int failure = 0, ended = 0;
  while (!failure && !ended) {
    struct kevent events[DORKOS_DARWIN_REQUEST_MAX];
    const int count = kevent(owner.queue, NULL, 0, events, DORKOS_DARWIN_REQUEST_MAX, NULL);
    if (count < 0) { if (errno == EINTR) continue; failure = 1; break; }
    if (count == DORKOS_DARWIN_REQUEST_MAX || leaf_events(&owner, events, count)) { failure = 1; break; }
    for (int i = 0; i < count && !failure && !ended; i++) {
      if (events[i].filter != EVFILT_READ || events[i].ident != STDIN_FILENO) continue;
      for (;;) {
        char byte;
        const ssize_t got = read(STDIN_FILENO, &byte, 1);
        if (!got) { ended = 1; if (retained) failure = 1; break; }
        if (got < 0) { if (errno == EINTR) continue; if (errno != EAGAIN) failure = 1; break; }
        if (byte == '\n') {
          line[retained] = '\0'; retained = 0;
          if (leaf_command(&owner, line)) { failure = 1; break; }
        } else if (retained == sizeof(line) - 1) { failure = 1; break; }
        else line[retained++] = byte;
      }
    }
  }
  if (close(owner.queue)) failure = 1;
  return failure ? 1 : 0;
}

static void print_identity(const struct dorkos_darwin_process *fact) {
  printf("{\"pid\":%d,\"seconds\":\"%" PRIu64 "\",\"microseconds\":\"%" PRIu64 "\"}",
    fact->pid, fact->seconds, fact->microseconds);
}
_Static_assert(sizeof(pid_t) <= 4 && sizeof(int) <= 4, "closed reply signed integer bound");
static int print_reply_body(const struct dorkos_darwin_batch *batch, const struct dorkos_darwin_children *result) {
  printf("{\"version\":1,\"bootSeconds\":\"%" PRIu64 "\",\"bootMicroseconds\":\"%" PRIu64 "\"",
    batch->boot_seconds, batch->boot_microseconds);
  if (result) {
    printf(",\"parentBefore\":");
    if (result->have_parent_before) print_identity(&result->parent_before); else printf("null");
    printf(",\"parentAfter\":");
    if (result->have_parent_after) print_identity(&result->parent_after); else printf("null");
    printf(",\"complete\":%s", result->complete ? "true" : "false");
    printf(",\"parentObservation\":{\"beforeError\":%d,\"afterError\":%d,\"beforeZombie\":%s,\"afterZombie\":%s,\"identityChanged\":%s}",
      result->parent_before_error, result->parent_after_error,
      !result->have_parent_before ? "null" : result->parent_before.zombie ? "true" : "false",
      !result->have_parent_after ? "null" : result->parent_after.zombie ? "true" : "false",
      !result->have_parent_before || !result->have_parent_after ? "null" :
        result->parent_before.seconds != result->parent_after.seconds ||
        result->parent_before.microseconds != result->parent_after.microseconds ? "true" : "false");
  }
  printf(",\"processes\":[");
  for (size_t i = 0; i < batch->count; i++) {
    const struct dorkos_darwin_process *fact = &batch->processes[i];
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
      if (fact->have_inspect_observation)
        printf(",\"inspection\":{\"membershipBefore\":%s,\"membershipAfter\":%s,\"firstError\":%d,\"secondError\":%d,\"firstZombie\":%s,\"secondZombie\":%s,\"birthChanged\":%s,\"parentChanged\":%s}",
          fact->membership_before ? "true" : "false", fact->membership_after ? "true" : "false",
          fact->first_error, fact->second_error,
          fact->first_zombie < 0 ? "null" : fact->first_zombie ? "true" : "false",
          fact->second_zombie < 0 ? "null" : fact->second_zombie ? "true" : "false",
          fact->birth_changed < 0 ? "null" : fact->birth_changed ? "true" : "false",
          fact->parent_changed < 0 ? "null" : fact->parent_changed ? "true" : "false");
      putchar('}');
    }
  }
  printf("]}");
  return ferror(stdout) ? 1 : 0;
}
static int print_reply(const struct dorkos_darwin_batch *batch, const struct dorkos_darwin_children *result) {
  if (print_reply_body(batch, result)) return 1;
  putchar('\n');
  return ferror(stdout) ? 1 : 0;
}
/* One original request at a time; each executes the unchanged read-only probe. */
static int observe_requests(void) {
  char line[8192];
  while (fgets(line, sizeof(line), stdin)) {
    const size_t length = strlen(line);
    if (!length || line[length - 1] != '\n' || (line[0] != 'I' && line[0] != 'C') || line[1] != ' ') return 2;
    pid_t pids[DORKOS_DARWIN_REQUEST_MAX]; size_t count = 0;
    char *cursor = line + 2;
    while (*cursor != '\n') {
      if (count == DORKOS_DARWIN_REQUEST_MAX || *cursor < '0' || *cursor > '9') return 2;
      char *end; errno = 0; const unsigned long value = strtoul(cursor, &end, 10);
      if (errno || !value || value > INT_MAX || (*end != ' ' && *end != '\n')) return 2;
      for (size_t i = 0; i < count; i++) if (pids[i] == (pid_t)value) return 2;
      pids[count++] = (pid_t)value;
      cursor = *end == ' ' ? end + 1 : end;
    }
    if (!count || (line[0] == 'C' && count != 1)) return 2;
    struct dorkos_darwin_batch batch;
    struct dorkos_darwin_children children;
    const int error = line[0] == 'C' ? dorkos_darwin_children(pids[0], &children) : dorkos_darwin_inspect(pids, count, &batch);
    if (error) { fprintf(stderr, "Darwin observation unavailable: %d\n", error); return 1; }
    if (line[0] == 'C') batch = children.batch;
    if (print_reply(&batch, line[0] == 'C' ? &children : NULL) || fflush(stdout)) return 1;
  }
  return ferror(stdin) ? 1 : 0;
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "observe-requests")) return observe_requests();
  if (argc == 2 && !strcmp(argv[1], "watch-leaves")) return watch_leaves();
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
  return print_reply(&batch, children ? &result : NULL);
}

#endif
