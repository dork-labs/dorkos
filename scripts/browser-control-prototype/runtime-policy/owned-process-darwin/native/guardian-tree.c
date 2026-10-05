#include "guardian.h"
#include "guardian-tree.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/socket.h>
#include <unistd.h>

struct guardian_tree {
  struct research_child *parent;
  struct research_unique_info parent_identity, child_identity;
  pid_t child_pid;
  int child_channel, queue;
  bool registered, child_exit_seen, closed_window, uncertain;
  unsigned long long cookie;
};
static unsigned long long deadline(struct guardian *g) {
  unsigned long long end = guardian_ms() + 2000;
  return end < g->end ? end : g->end;
}
static int fresh(struct guardian *g, int channel, pid_t pid, unsigned long long end) {
  unsigned char random[32]; char nonce[65], request[96], expected[160], observed[160];
  arc4random_buf(random, sizeof(random));
  if (!guardian_digest(random, sizeof(random), nonce)) return 0;
  snprintf(request, sizeof(request), "CHALLENGE\t%s\n", nonce);
  snprintf(expected, sizeof(expected), "ALIVE\t%d\t%s\tFORK_CLOSED\tREAP_CLOSED", pid, nonce);
  return guardian_write(g, channel, request, end) && guardian_read(g, channel, observed, sizeof(observed), end) && !strcmp(expected, observed);
}
static int parent_current(struct guardian *g, struct guardian_tree *tree, unsigned long long end) {
  bool exited = true; struct research_unique_info current;
  pid_t pid = research_pid(tree->parent);
  if (g->control_lost || pid < 1 || research_exit_state(tree->parent, &exited).status != 1 || exited ||
      research_unique(pid, &current).status != 1 || current.unique_id != tree->parent_identity.unique_id ||
      current.version != tree->parent_identity.version) return 0;
  return fresh(g, research_channel(tree->parent), pid, end);
}
static int child_current(struct guardian *g, struct guardian_tree *tree, unsigned long long end) {
  struct research_unique_info current;
  /* This PID comes only from the sole settled fork permit/exclusive transferred channel. */
  if (g->control_lost || tree->child_pid < 1 || tree->child_channel < 0 ||
      research_unique(tree->child_pid, &current).status != 1 ||
      current.unique_id != tree->child_identity.unique_id || current.version != tree->child_identity.version ||
      current.parent_unique_id != tree->parent_identity.unique_id) return 0;
  return fresh(g, tree->child_channel, tree->child_pid, end);
}
static int child_transfer(struct guardian *g, struct guardian_tree *tree, unsigned long long end) {
  /* Preallocated tree slot exists before requesting any fork or receiving SCM_RIGHTS. */
  if (!guardian_write(g, research_channel(tree->parent), "FORK_ONE\n", end)) return 0;
  int socket = research_channel(tree->parent);
  while (guardian_ms() < end && !g->control_lost) {
    struct pollfd ready = {socket, POLLIN, 0};
    int available = poll(&ready, 1, 10);
    if (available < 0 && errno == EINTR) continue;
    if (available < 0 || (ready.revents & (POLLERR | POLLNVAL | POLLHUP))) return 0;
    if (!available) continue;
    char text[128], control[CMSG_SPACE(sizeof(int))];
    struct iovec vector = {text, sizeof(text) - 1};
    struct msghdr message; memset(&message, 0, sizeof(message));
    message.msg_iov = &vector; message.msg_iovlen = 1;
    message.msg_control = control; message.msg_controllen = sizeof(control);
    ssize_t bytes = recvmsg(socket, &message, 0);
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    if (header && header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS && header->cmsg_len == CMSG_LEN(sizeof(int)))
      memcpy(&tree->child_channel, CMSG_DATA(header), sizeof(tree->child_channel));
    /* Retain/close a received owned channel even if any subsequent payload validation fails. */
    if (bytes < 1 || bytes >= (ssize_t)sizeof(text) || (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) ||
        !header || CMSG_NXTHDR(&message, header) || tree->child_channel < 3 ||
        fcntl(tree->child_channel, F_SETFD, FD_CLOEXEC)) return 0;
    text[bytes] = 0;
    int pid, consumed = 0; unsigned long long expiry;
    if (sscanf(text, "CHILD\t%d\t%llu\tFORK_CLOSED\tREAP_CLOSED\n%n", &pid, &expiry, &consumed) != 2 ||
        consumed != bytes || pid < 1 || pid == research_pid(tree->parent) || expiry != research_expiry(tree->parent)) return 0;
    tree->child_pid = pid; tree->closed_window = true; g->acquisitions++;
    if (!fresh(g, tree->child_channel, pid, end)) return 0;
    if (research_unique(pid, &tree->child_identity).status != 1 ||
        tree->child_identity.parent_unique_id != tree->parent_identity.unique_id) return 0;
    return child_current(g, tree, end);
  }
  return 0;
}
static int census(struct guardian *g, struct guardian_tree *tree, unsigned long long end) {
  int snapshot[2][8]; memset(snapshot, 0, sizeof(snapshot));
  int counts[2] = {0, 0};
  for (int fill = 0; fill < 2; fill++) {
    if (!parent_current(g, tree, end) || !child_current(g, tree, end)) return 0;
    errno = 0;
    g->census_calls++;
    counts[fill] = g->list_children(research_pid(tree->parent), snapshot[fill], sizeof(snapshot[fill]));
    int error = errno;
    if (counts[fill] <= 0 || counts[fill] >= 8 || error) return 0;
    for (int i = 0; i < counts[fill]; i++) {
      if (snapshot[fill][i] < 1) return 0;
      for (int j = i + 1; j < counts[fill]; j++) if (snapshot[fill][i] == snapshot[fill][j]) return 0;
    }
    if (!parent_current(g, tree, end) || !child_current(g, tree, end)) return 0;
  }
  if (counts[0] != counts[1]) return 0;
  for (int i = 0; i < counts[0]; i++) {
    int found = 0;
    for (int j = 0; j < counts[1]; j++) found += snapshot[0][i] == snapshot[1][j];
    if (found != 1) return 0;
  }
  /* One actual-success permit, not a global count or cleanup-ledger substitute. */
  if (counts[0] != 1 || snapshot[0][0] != tree->child_pid) return 0;
  return 1;
}
static int register_exit(struct guardian *g, struct guardian_tree *tree, unsigned long long end) {
  if (!child_current(g, tree, end)) return 0;
  tree->queue = kqueue();
  if (tree->queue < 0 || fcntl(tree->queue, F_SETFD, FD_CLOEXEC)) return 0;
  struct kevent change, receipt; memset(&receipt, 0, sizeof(receipt));
  tree->cookie = 1; /* Stable slot address plus nonzero generation, never authority by itself. */
  EV_SET(&change, (uintptr_t)tree->child_pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_RECEIPT, NOTE_EXIT, 0, &tree->cookie);
  struct timespec immediate = {0, 0};
  g->exit_registrations++;
  int count = kevent(tree->queue, &change, 1, &receipt, 1, &immediate);
  if (count != 1 || receipt.ident != (uintptr_t)tree->child_pid || receipt.filter != EVFILT_PROC ||
      !(receipt.flags & EV_ERROR) || receipt.data != 0 || receipt.udata != &tree->cookie) return 0;
  tree->registered = true;
  return child_current(g, tree, end) && parent_current(g, tree, end);
}
int guardian_tree_open(struct guardian *g) {
  if (g->tree || g->control_lost || g->acquisitions || !g->list_children || (strcmp(g->cohort, "C2") && strcmp(g->cohort, "C3"))) return 0;
  g->tree = calloc(1, sizeof(*g->tree));
  if (!g->tree) return 0;
  struct guardian_tree *tree = g->tree; tree->child_channel = -1; tree->queue = -1;
  if (!guardian_bound_asset(g, g->fixture_a, g->hash_a) || !guardian_bound_asset(g, g->fixture_b, g->hash_b)) return 0;
  int error = 0;
  /* Direct parent and non-direct child slots are installed before fallible acquisition. */
  tree->parent = research_spawn_parent(g->fixture_a, g->fixture_b, &error);
  g->slots[0] = tree->parent;
  if (!tree->parent) return 0;
  g->acquisitions++;
  unsigned long long end = deadline(g); char text[160]; int pid, used = 0; unsigned long long expiry;
  if (!guardian_read(g, research_channel(tree->parent), text, sizeof(text), end) ||
      sscanf(text, "PARENT_READY\t%d\t%llu%n", &pid, &expiry, &used) != 2 || text[used] ||
      pid != research_pid(tree->parent) || expiry != research_expiry(tree->parent) ||
      research_unique(pid, &tree->parent_identity).status != 1) return 0;
  if (!child_transfer(g, tree, end) || !census(g, tree, end) || !register_exit(g, tree, end)) {
    tree->uncertain = true; return 0;
  }
  return 1;
}
int guardian_tree_parent_death(struct guardian *g) {
  struct guardian_tree *tree = g->tree;
  if (!tree || !tree->registered || tree->uncertain || g->signals || g->control_lost) return 0;
  unsigned long long end = deadline(g);
  if (!parent_current(g, tree, end) || !child_current(g, tree, end)) return 0;
  /* Sole G wait custody retains this exact unreaped direct PID across the public signal call. */
  pid_t pid = research_pid(tree->parent);
  if (pid < 1) return 0;
  g->signals++;
  errno = 0; int raw = kill(pid, SIGKILL), error = errno, observed = 0, wait_status = 0;
  while (!raw && guardian_ms() < end && !g->control_lost) {
    bool exited = false;
    if (research_exit_state(tree->parent, &exited).status != 1) break;
    if (exited) { observed = research_reap(tree->parent, &wait_status).status == 1; break; }
    usleep(1000);
  }
  char report[512];
  snprintf(report, sizeof(report), "{\"type\":\"termination\",\"cohort\":\"%s\",\"ordinal\":1,\"raw\":%d,\"status\":%d,\"error\":%d,\"chosenSignal\":9,\"waitStatus\":%d,\"observed\":%s}", g->cohort, raw, observed ? 1 : 0, error, wait_status, observed ? "true" : "false");
  guardian_emit(report); g->terminations += observed;
  if (!observed) { tree->uncertain = true; return 0; }
  /* No new PPID census or numeric identity lookup after parent death. */
  return fresh(g, tree->child_channel, tree->child_pid, end);
}
int guardian_tree_close(struct guardian *g, unsigned long long end) {
  struct guardian_tree *tree = g->tree;
  if (!tree) return 1;
  if (tree->child_channel >= 0) { close(tree->child_channel); tree->child_channel = -1; }
  if (tree->child_exit_seen && tree->queue < 0) return !tree->uncertain && !g->control_lost;
  if (!tree->registered || tree->queue < 0) return 0;
  while (guardian_ms() < end && !tree->child_exit_seen) {
    struct kevent event; struct timespec wait = {0, 10000000};
    int count = kevent(tree->queue, NULL, 0, &event, 1, &wait);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return 0;
    if (!count) continue;
    if (event.ident != (uintptr_t)tree->child_pid || event.filter != EVFILT_PROC ||
        event.udata != &tree->cookie || !(event.fflags & NOTE_EXIT) || (event.flags & EV_ERROR)) return 0;
    tree->child_exit_seen = true; g->exit_events++;
  }
  if (!tree->child_exit_seen) return 0;
  close(tree->queue); tree->queue = -1;
  /* Exit notification is not reaping or general allGone; uncertainty remains irreversible. */
  return !tree->uncertain && !g->control_lost;
}
