#include "tree-fixture.h"
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static unsigned long long now_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value)) _exit(70);
  return (unsigned long long)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}
static void expired(int signal) { (void)signal; _exit(0); }
static int expiry(unsigned long long end) {
  unsigned long long now = now_ms();
  if (end <= now || end - now > 15000) return 0;
  struct sigaction action; memset(&action, 0, sizeof(action));
  action.sa_handler = expired; sigemptyset(&action.sa_mask);
  if (sigaction(SIGALRM, &action, NULL)) return 0;
  unsigned long long remaining = end - now;
  struct itimerval timer = {{0, 0}, {(time_t)(remaining / 1000), (suseconds_t)((remaining % 1000) * 1000)}};
  return setitimer(ITIMER_REAL, &timer, NULL) == 0;
}
static int read_line(char text[160], unsigned long long end) {
  size_t used = 0;
  while (now_ms() < end) {
    struct pollfd fd = {STDIN_FILENO, POLLIN, 0};
    int result = poll(&fd, 1, 10);
    if (result < 0 && errno == EINTR) continue;
    if (result < 0 || (fd.revents & (POLLERR | POLLNVAL))) return 0;
    if (!result) continue;
    char byte; ssize_t count = read(STDIN_FILENO, &byte, 1);
    if (count < 0 && errno == EINTR) continue;
    if (count != 1) return 0;
    if (byte == '\n') { text[used] = 0; return 1; }
    if (!byte || byte == '\r' || used >= 159) return 0;
    text[used++] = byte;
  }
  return 0;
}
static int challenge(const char *text) {
  if (strncmp(text, "CHALLENGE\t", 10) || strlen(text) != 74) return 0;
  for (int i = 10; i < 74; i++)
    if (!((text[i] >= '0' && text[i] <= '9') || (text[i] >= 'a' && text[i] <= 'f'))) return 0;
  printf("ALIVE\t%d\t%s\tFORK_CLOSED\tREAP_CLOSED\n", getpid(), text + 10);
  return fflush(stdout) == 0;
}
static int descendant(unsigned long long end, int own, int other) {
  /* Only this acquired child's own channels are closed; no process search or signaling. */
  close(other);
  if (dup2(own, STDIN_FILENO) < 0 || dup2(own, STDOUT_FILENO) < 0) return 70;
  if (own > STDERR_FILENO) close(own);
  if (!expiry(end)) return 70;
  char text[160];
  while (read_line(text, end)) {
    if (!strcmp(text, "EXIT")) return 0;
    if (!challenge(text)) return 65;
  }
  return 0;
}
static int transfer(pid_t child, int channel, unsigned long long end) {
  char text[96]; int length = snprintf(text, sizeof(text), "CHILD\t%d\t%llu\tFORK_CLOSED\tREAP_CLOSED\n", child, end);
  if (length < 1 || (size_t)length >= sizeof(text)) return 0;
  char control[CMSG_SPACE(sizeof(int))]; memset(control, 0, sizeof(control));
  struct iovec vector = {text, (size_t)length};
  struct msghdr message; memset(&message, 0, sizeof(message));
  message.msg_iov = &vector; message.msg_iovlen = 1;
  message.msg_control = control; message.msg_controllen = sizeof(control);
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(header), &channel, sizeof(channel));
  return sendmsg(STDOUT_FILENO, &message, 0) == length;
}
int research_parent_fixture(unsigned long long original_expiry) {
  /* One declared permit only. The extra-E numerical variant is unsupported/unreleased. */
  if (!expiry(original_expiry)) return 70;
  printf("PARENT_READY\t%d\t%llu\n", getpid(), original_expiry);
  if (fflush(stdout)) return 74;
  char text[160]; int forked = 0;
  while (read_line(text, original_expiry)) {
    if (!strcmp(text, "EXIT")) return 0;
    if (!strcmp(text, "FORK_ONE") && !forked) {
      int channels[2];
      if (socketpair(AF_UNIX, SOCK_STREAM, 0, channels)) return 70;
      /* Fork result settles this sole permit before the permanent closed-window report. */
      forked = 1;
      pid_t child = fork();
      if (child < 0) { close(channels[0]); close(channels[1]); return 70; }
      if (!child) _exit(descendant(original_expiry, channels[1], channels[0]));
      close(channels[1]);
      int transferred = transfer(child, channels[0], original_expiry);
      close(channels[0]);
      if (!transferred) return 74;
      /* No further fork or wait/reap call occurs; G holds the exclusive child lifeline. */
      continue;
    }
    if (!forked || !challenge(text)) return 65;
  }
  return 0;
}
