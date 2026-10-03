#include "guardian.h"
#include <dlfcn.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

static void expired(int sig) { (void)sig; _exit(75); }
static int bytes(void *destination, size_t length) {
  unsigned char *buffer = destination; size_t read_bytes = 0;
  unsigned long long end = guardian_ms() + 2000;
  while (read_bytes < length && guardian_ms() < end) {
    struct pollfd fd = {STDIN_FILENO, POLLIN, 0};
    int ready = poll(&fd, 1, 10);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0 || (fd.revents & (POLLHUP | POLLERR | POLLNVAL))) return 0;
    if (!ready) continue;
    ssize_t size = read(STDIN_FILENO, buffer + read_bytes, length - read_bytes);
    if (size < 0 && errno == EINTR) continue;
    if (size < 1) return 0;
    read_bytes += (size_t)size;
  }
  return read_bytes == length;
}
static int command(struct guardian *g) {
  unsigned char prefix[4];
  if (!bytes(prefix, 4)) return 0;
  unsigned int length = ((unsigned int)prefix[0] << 24) | ((unsigned int)prefix[1] << 16) | ((unsigned int)prefix[2] << 8) | prefix[3];
  char frame[4097], canonical[4097];
  if (!length || length > 4096 || !bytes(frame, length)) return 0;
  frame[length] = 0;
  unsigned int phase, allowance; int end = 0;
  if (sscanf(frame, "{\"type\":\"run\",\"run\":\"%64[A-Za-z0-9-]\",\"cohort\":\"%2[C1-6]\",\"phaseMs\":%u,\"signalAllowance\":%u,\"custody\":[\"%255[0-9:]\",\"%255[0-9:]\",\"%255[0-9:]\",\"%255[0-9:]\"]}%n", g->run, g->cohort, &phase, &allowance, g->bindings[0], g->bindings[1], g->bindings[2], g->bindings[3], &end) != 8 || (unsigned int)end != length) return 0;
  unsigned int caps[] = {24000, 12000, 10000, 8000, 12000, 16000};
  unsigned int signals[] = {14, 1, 1, 0, 0, 0};
  if (g->cohort[0] != 'C' || g->cohort[1] < '1' || g->cohort[1] > '6' || g->cohort[2] || !phase ||
      phase > caps[g->cohort[1] - '1'] || allowance != signals[g->cohort[1] - '1']) return 0;
  snprintf(canonical, sizeof(canonical), "{\"type\":\"run\",\"run\":\"%s\",\"cohort\":\"%s\",\"phaseMs\":%u,\"signalAllowance\":%u,\"custody\":[\"%s\",\"%s\",\"%s\",\"%s\"]}", g->run, g->cohort, phase, allowance, g->bindings[0], g->bindings[1], g->bindings[2], g->bindings[3]);
  if (strcmp(frame, canonical)) return 0;
  g->end = guardian_ms() + phase; return 1;
}
static int assets(struct guardian *g, const char *root, const char *hash_a, const char *hash_b) {
  struct stat stat; char canonical[4096];
  if (!realpath(root, canonical) || strcmp(root, canonical) || lstat(root, &stat) || !S_ISDIR(stat.st_mode) ||
      stat.st_uid != getuid() || (stat.st_mode & 0777) != 0700 || strlen(hash_a) != 64 || strlen(hash_b) != 64) return 0;
  for (int i = 0; i < 64; i++) if (!((hash_a[i] >= '0' && hash_a[i] <= '9') || (hash_a[i] >= 'a' && hash_a[i] <= 'f')) ||
      !((hash_b[i] >= '0' && hash_b[i] <= '9') || (hash_b[i] >= 'a' && hash_b[i] <= 'f'))) return 0;
  int a = snprintf(g->fixture_a, sizeof(g->fixture_a), "%s/fixture-a", root);
  int b = snprintf(g->fixture_b, sizeof(g->fixture_b), "%s/fixture-b", root);
  if (a < 0 || b < 0 || (size_t)a >= sizeof(g->fixture_a) || (size_t)b >= sizeof(g->fixture_b)) return 0;
  strcpy(g->hash_a, hash_a); strcpy(g->hash_b, hash_b); strcpy(g->root, root);
  return guardian_bound_asset(g, g->fixture_a, g->hash_a) && guardian_bound_asset(g, g->fixture_b, g->hash_b);
}
static int exports(struct guardian *g) {
  void *library = dlopen("/usr/lib/libproc.dylib", RTLD_NOW | RTLD_LOCAL);
  if (!library) return 0;
  int available = dlsym(library, "proc_pidinfo") && dlsym(library, "proc_signal_with_audittoken") && dlsym(library, "proc_terminate_with_audittoken");
  g->list_children = (int (*)(pid_t, void *, int))dlsym(library, "proc_listchildpids");
  g->installed_library = library; return available && g->list_children;
}
int main(int argc, char **argv) {
  if (argc != 5 || strcmp(argv[1], "--guardian")) return 64;
  struct sigaction action; memset(&action, 0, sizeof(action)); action.sa_handler = expired; sigemptyset(&action.sa_mask);
  if (sigaction(SIGALRM, &action, NULL)) return 70;
  action.sa_handler = SIG_IGN; if (sigaction(SIGPIPE, &action, NULL)) return 70;
  struct itimerval timer = {{0, 0}, {110, 0}};
  if (setitimer(ITIMER_REAL, &timer, NULL)) return 70;
  struct guardian g; memset(&g, 0, sizeof(g));
  if (!command(&g)) return 65;
  /* Counted G in-process export resolution precedes every fixture/query/candidate. */
  if (!exports(&g)) g.reason = "NATIVE_EXPORT_UNAVAILABLE";
  else if (!assets(&g, argv[2], argv[3], argv[4])) g.reason = "CUSTODY_UNVERIFIED";
  else if (!guardian_exercise(&g) && !g.reason) g.reason = "PRIVATE_NATIVE_CONTROL_UNVERIFIED";
  guardian_cleanup(&g);
  char receipt[1024];
  const char *coverage = (!strcmp(g.cohort, "C1") || !strcmp(g.cohort, "C3")) && !g.reason ? "continuous" : "unknown";
  snprintf(receipt, sizeof(receipt), "{\"type\":\"result\",\"cohort\":\"%s\",\"status\":\"%s\",\"reason\":\"%s\",\"fixtureSubjects\":%u,\"identityQueries\":%u,\"censusCalls\":%u,\"exitRegistrations\":%u,\"exitEvents\":%u,\"signals\":%u,\"deliveries\":%u,\"refusals\":%u,\"terminations\":%u,\"coverage\":\"%s\",\"slotsClosed\":%s}", g.cohort,
    g.failed ? "failed" : (g.reason ? "unverified" : "observed"), g.reason ? g.reason : (!strcmp(g.cohort, "C1") ? "DIRECT_CANDIDATE_OBSERVED" : "OWNED_TREE_BARRIER_OBSERVED"),
    g.acquisitions, research_identity_queries() + g.token_queries, g.census_calls, g.exit_registrations, g.exit_events, g.signals, g.deliveries, g.refusals, g.terminations, coverage, g.cleanup_known ? "true" : "false");
  guardian_emit(receipt); return g.failed ? 1 : (g.reason || !g.cleanup_known ? 2 : 0);
}
