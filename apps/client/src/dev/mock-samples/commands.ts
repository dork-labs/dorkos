/**
 * Command-palette fixtures — a short, realistic set and a "long" set that
 * exercises long descriptions, argument hints, and deeply nested namespaces.
 *
 * @module dev/mock-samples/commands
 */
export const SAMPLE_COMMANDS: import('@dorkos/shared/types').CommandEntry[] = [
  {
    namespace: 'built-in',
    command: 'commit',
    fullCommand: '/commit',
    description: 'Stage and commit changes with a generated message',
  },
  {
    namespace: 'built-in',
    command: 'test',
    fullCommand: '/test',
    description: 'Run the test suite',
    argumentHint: '<file-or-pattern>',
  },
  {
    namespace: 'built-in',
    command: 'review',
    fullCommand: '/review',
    description: 'Review code changes in the current branch',
  },
  {
    namespace: 'linear',
    command: 'idea',
    fullCommand: '/linear:idea',
    description: 'Quick-capture an idea into Linear',
    argumentHint: '<idea text>',
  },
  {
    namespace: 'linear',
    command: 'done',
    fullCommand: '/linear:done',
    description: 'Report completion and close the loop on an issue',
  },
  {
    namespace: 'adr',
    command: 'create',
    fullCommand: '/adr:create',
    description: 'Create a new Architecture Decision Record',
    argumentHint: '<title>',
  },
  {
    namespace: 'adr',
    command: 'list',
    fullCommand: '/adr:list',
    description: 'List all ADRs with status',
  },
];

/** Commands with long text — descriptions, argument hints, and deeply nested namespaces. */
export const SAMPLE_COMMANDS_LONG: import('@dorkos/shared/types').CommandEntry[] = [
  {
    namespace: 'app',
    command: 'upgrade',
    fullCommand: '/app:upgrade',
    description:
      'Comprehensive dependency upgrade with security audit, prioritization, and validation',
  },
  {
    namespace: 'app',
    command: 'cleanup',
    fullCommand: '/app:cleanup',
    description:
      'Comprehensive code cleanup using Knip and best practices for codebase maintenance',
  },
  {
    namespace: 'chat',
    command: 'self-test',
    fullCommand: '/chat:self-test',
    description:
      'Self-test the DorkOS chat UI in a live browser session — drives real interactions, monitors JSONL transcript, compares API vs UI, researches issues, and produces an evidence-based findings report',
    argumentHint: '[url] [focus:area1,area2]',
  },
  {
    namespace: 'debug',
    command: 'rubber-duck',
    fullCommand: '/debug:rubber-duck',
    description:
      'Structured problem articulation using rubber duck debugging methodology to systematically work through complex bugs',
    argumentHint: '[brief-problem-description]',
  },
  {
    namespace: 'debug',
    command: 'api',
    fullCommand: '/debug:api',
    description:
      'Debug API and data flow issues by tracing through Component -> TanStack Query -> Express Route -> Service -> SQLite/JSONL',
    argumentHint: '[endpoint-or-feature] [--url <url>]',
  },
  {
    namespace: 'debug',
    command: 'performance',
    fullCommand: '/debug:performance',
    description:
      'Diagnose performance issues including slow renders, bundle size, N+1 queries, and memory leaks',
    argumentHint: '[area-or-symptom] [--url <url>]',
  },
  {
    namespace: 'adr',
    command: 'review',
    fullCommand: '/adr:review',
    description:
      'Review proposed ADRs for lifecycle progression — accept implemented decisions, deprecate stale ones, archive trivial ones',
    argumentHint: '[spec-slug | ADR-number | --all]',
  },
  {
    namespace: 'template',
    command: 'update',
    fullCommand: '/template:update',
    description:
      'Update project from upstream template with selective file updates and conflict resolution',
    argumentHint:
      '[all|harness|guides|selective] [--dry-run] [--verbose] [--force] [--version <tag>]',
  },
  {
    namespace: 'research',
    command: 'curate',
    fullCommand: '/research:curate',
    description:
      'Curate research files — inventory by type, identify stale/superseded candidates, update frontmatter status',
  },
  {
    namespace: 'review-recent-work',
    command: 'review-recent-work',
    fullCommand: '/review-recent-work',
    description:
      'Trace through recent code changes to verify implementation correctness and completeness',
  },
];
