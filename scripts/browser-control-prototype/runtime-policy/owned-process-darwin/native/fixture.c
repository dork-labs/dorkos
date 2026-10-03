#include "bridge.h"
#include "tree-fixture.h"
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>
#include <unistd.h>

#ifndef DORK_FIXTURE_IMAGE
#define DORK_FIXTURE_IMAGE 1
#endif
static volatile sig_atomic_t deliveries;
static void delivered(int sig) { (void)sig; if (deliveries < 24) deliveries++; }
static void expired(int sig) { (void)sig; _exit(0); }
static unsigned long long monotonic_ms(void) {
  struct timespec time;
  if (clock_gettime(CLOCK_MONOTONIC, &time)) _exit(70);
  return (unsigned long long)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}
static int word(const char *s) {
  size_t size = strlen(s);
  if (size < 1 || size > 64) return 0;
  for (size_t i = 0; i < size; i++)
    if (!((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= 'A' && s[i] <= 'Z') ||
          (s[i] >= '0' && s[i] <= '9') || s[i] == '-')) return 0;
  return 1;
}
static int decimal(const char *text, unsigned long long *number) {
  if (!text || !*text || (text[0] == '0' && text[1])) return 0;
  unsigned long long value = 0;
  for (const char *p = text; *p; p++) {
    if (*p < '0' || *p > '9' || value > (9007199254740991ULL - (*p - '0')) / 10) return 0;
    value = value * 10 + (*p - '0');
  }
  *number = value; return 1;
}
static int hex(const char *text) {
  if (strlen(text) != 64) return 0;
  for (int i = 0; i < 64; i++) if (!((text[i] >= '0' && text[i] <= '9') || (text[i] >= 'a' && text[i] <= 'f'))) return 0;
  return 1;
}
static void token(void) {
  audit_token_t value;
  struct research_result r = research_self_token(&value);
  printf("TOKEN\t%d\t%d\t%d\t", r.status, r.raw, r.error);
  if (r.status == 1) {
    const unsigned char *bytes = (const unsigned char *)&value;
    for (size_t i = 0; i < sizeof(value); i++) printf("%02x", bytes[i]);
  }
  puts(""); fflush(stdout);
}
static void ack(char *const fields[], const char *type, int counter) {
  printf("%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%d\n", type,
    fields[1], fields[2], fields[3], fields[4], fields[5], fields[6], fields[7], counter);
  fflush(stdout);
}
static int arm(char *line, char *fields[]) {
  fields[0] = line;
  for (int i = 1; i < 9; i++) {
    char *separator = strchr(fields[i - 1], '\t');
    if (!separator) return 0;
    *separator = 0; fields[i] = separator + 1;
  }
  for (int i = 0; i < 9; i++) if (!word(fields[i])) return 0;
  if (strchr(fields[8], '\t') || strcmp(fields[0], "ARM") ||
      (strcmp(fields[2], "kernel") && strcmp(fields[2], "constructed")) ||
      !hex(fields[6]) || !hex(fields[7])) return 0;
  unsigned long long generation, pid, baseline;
  if (!decimal(fields[4], &generation) || generation < 1 || !decimal(fields[5], &pid) ||
      pid != (unsigned long long)getpid() || !decimal(fields[8], &baseline) || baseline != (unsigned int)deliveries || baseline >= 24) return 0;
  ack(fields, "ARMED", deliveries); return 1;
}
int main(int argc, char **argv) {
  if (argc != 2 || (strcmp(argv[1], "--fixture") && strcmp(argv[1], "--parent"))) return 64;
  unsigned long long expiry, initial;
  const char *image_b = getenv("DORK_RESEARCH_IMAGE_B");
  if (!decimal(getenv("DORK_RESEARCH_EXPIRY"), &expiry) || expiry <= monotonic_ms() ||
      expiry - monotonic_ms() > 15000 || !decimal(getenv("DORK_RESEARCH_COUNTER"), &initial) ||
      initial > 24 || !image_b || image_b[0] != '/') return 64;
  deliveries = (sig_atomic_t)initial;
  struct sigaction action; memset(&action, 0, sizeof(action));
  action.sa_handler = delivered; sigemptyset(&action.sa_mask);
  if (sigaction(SIGUSR1, &action, NULL)) return 70;
  action.sa_handler = expired;
  if (sigaction(SIGALRM, &action, NULL)) return 70;
  unsigned long long current = monotonic_ms();
  if (current >= expiry) return 0;
  unsigned long long remaining = expiry - current;
  struct itimerval timer = {{0, 0}, {(time_t)(remaining / 1000), (suseconds_t)((remaining % 1000) * 1000)}};
  if (setitimer(ITIMER_REAL, &timer, NULL)) return 70;
  if (!strcmp(argv[1], "--parent")) return research_parent_fixture(expiry);
  /* The absolute original acquisition expiry survives exec; ARM/READY cannot renew it. */
  printf("READY\t%d\t%llu\t%d\t%d\n", getpid(), expiry, deliveries, DORK_FIXTURE_IMAGE); fflush(stdout);
  char line[640], binding[640], *fields[9];
  size_t length = 0; int armed = 0; sig_atomic_t baseline = 0;
  for (;;) {
    if (monotonic_ms() >= expiry) return 0;
    if (armed && deliveries > baseline) { ack(fields, "DELIVERED", deliveries); armed = 0; }
    struct pollfd input = {STDIN_FILENO, POLLIN, 0};
    int ready = poll(&input, 1, 25);
    if (ready < 0) { if (errno == EINTR) continue; return 74; }
    if (!ready) continue;
    char byte; ssize_t size = read(STDIN_FILENO, &byte, 1);
    if (size == 0) return 0;
    if (size < 0) { if (errno == EINTR) continue; return 74; }
    if (byte == '\n') {
      line[length] = 0; length = 0;
      if (!strcmp(line, "EXIT")) return 0;
      if (!strcmp(line, "TOKEN") && !armed) { token(); continue; }
      if (!strcmp(line, "CANCEL") && armed) { ack(fields, "CANCELLED", deliveries); armed = 0; continue; }
      if (!strcmp(line, "EXEC") && !armed) {
        char counter[32]; snprintf(counter, sizeof(counter), "%d", deliveries);
        if (setenv("DORK_RESEARCH_COUNTER", counter, 1)) return 70;
        execl(image_b, image_b, "--fixture", (char *)NULL); return 70;
      }
      if (armed) return 65;
      strcpy(binding, line); baseline = deliveries; armed = arm(binding, fields);
      if (!armed) return 65;
    } else {
      if (length >= sizeof(line) - 1 || byte == 0 || byte == '\r') return 65;
      line[length++] = byte;
    }
  }
}
