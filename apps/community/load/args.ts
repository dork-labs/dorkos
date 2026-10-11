import { parseArgs } from 'node:util';

/** Hostnames the script treats as "local": refused to run anywhere else without the flag. */
// `URL#hostname` keeps the brackets on an IPv6 literal, so `::1` arrives as `[::1]`.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Parsed and validated command-line options for one load run. */
export interface LoadArgs {
  url: string;
  readers: number;
  writers: number;
  ratePerSecond: number;
  durationSeconds: number;
  communityName: string;
  channelName: string;
  out: string;
  /** After the last post, stop waiting once no delivery has arrived for this long. */
  quietMs: number;
  /** After the last post, never wait longer than this for deliveries still on their way. */
  drainTimeoutSeconds: number;
  /** Reader worker threads, `0` to read on the main thread, or `auto`: one per 1,000 readers. */
  readerThreads: number | 'auto';
  /** How long to wait for every stream to open before posting starts anyway. */
  openTimeoutSeconds: number;
  /** Seed only, write the fixture here, and exit: the first step of a run split across machines. */
  fixtureOut?: string;
  /** Use the fixture `--fixture-out` wrote instead of seeding one. */
  fixture?: string;
  /** This machine's share of a split run: part `index` (1-based) of `count`. */
  part: { index: number; count: number };
  /** When posting starts, in epoch milliseconds, so every part of a split run posts at once. */
  startAt?: number;
  /** Things worth saying before the run starts, none of which stops it. */
  warnings: string[];
}

/** The shortest `--quiet-ms`: twice the reader shares' once-a-second progress reports. */
const MIN_QUIET_MS = 2_000;

/**
 * The server's default posting limit for one member (and every agent it owns):
 * `COMMUNITY_POSTS_PER_TEN_MINUTES`. Each writer is its own member, so a run asking one writer
 * for more than this inside ten minutes measures the limiter, not delivery.
 */
const DEFAULT_POSTS_PER_MEMBER_PER_TEN_MINUTES = 120;

/** Raise with a message printed to the user; never a stack trace. */
export class UsageError extends Error {
  /**
   * Build one.
   *
   * @param message - What to print.
   * @param isHelp - The message is the `--help` text, asked for: print it and exit 0.
   */
  constructor(
    message: string,
    readonly isHelp = false
  ) {
    super(message);
  }
}

/**
 * Parse and validate `argv`, refusing a non-local `--url` unless
 * `--i-understand-this-is-production` says so explicitly. D12's production run is real load on
 * a real host, so this is the one guard standing between a careless flag and someone else's
 * live community.
 */
export function parseLoadArgs(argv: readonly string[]): LoadArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      readers: { type: 'string', default: '1000' },
      writers: { type: 'string', default: '50' },
      rate: { type: 'string', default: '50' },
      duration: { type: 'string', default: '60' },
      'community-name': { type: 'string', default: 'Load test community' },
      'channel-name': { type: 'string', default: 'load-test' },
      out: { type: 'string', default: 'load-results.json' },
      'quiet-ms': { type: 'string', default: '5000' },
      'drain-timeout': { type: 'string', default: '120' },
      'reader-threads': { type: 'string', default: 'auto' },
      'open-timeout': { type: 'string', default: '300' },
      'fixture-out': { type: 'string' },
      fixture: { type: 'string' },
      part: { type: 'string', default: '1/1' },
      'start-at': { type: 'string' },
      'i-understand-this-is-production': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    throw new UsageError(
      [
        'Usage: pnpm --filter @dorkos/community load --url <base-url> [options]',
        '',
        '  --url <url>              Community server base URL (required).',
        '  --readers <n>             Reader agents to open streams for (default 1000).',
        '  --writers <n>             Writer agents sharing --rate, each its own member (default 50).',
        '  --rate <n>                Total posts per second across all writers (default 50).',
        '  --duration <seconds>      How long writers post for (default 60).',
        '  --community-name <name>   Throwaway community name (default "Load test community").',
        '  --channel-name <name>     Throwaway channel name (default "load-test").',
        '  --out <path>              Where to write the JSON results (default ./load-results.json).',
        '  --quiet-ms <ms>           After the last post, stop waiting for deliveries once none',
        '                            has arrived for this long (default 5000).',
        '  --drain-timeout <seconds> After the last post, wait at most this long for every',
        '                            stream to get every post (default 120).',
        '  --reader-threads <n>      Threads reading streams; 0 reads on the main thread',
        '                            (default auto: one per 1,000 readers, up to the cores).',
        '  --open-timeout <seconds>  How long to wait for every stream to open before posting',
        '                            starts anyway; late streams count as failures (default 300).',
        '',
        'Splitting one run across several load machines (see OPERATIONS.md):',
        '  --fixture-out <path>      Seed the community, write its credentials here, and exit.',
        '  --fixture <path>          Use that file instead of seeding. --readers and --writers',
        '                            are then read from it.',
        '  --part <k>/<n>            Run part k of n: its share of the readers and writers, at',
        '                            --rate divided by n (default 1/1).',
        '  --start-at <time>         Start posting at this ISO 8601 time, so every part posts',
        "                            together (default: as soon as this part's streams are open).",
        '',
        '  --i-understand-this-is-production',
        '                            Required to target a non-local --url.',
      ].join('\n'),
      true
    );
  }

  if (!values.url) throw new UsageError('--url is required (try --help).');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(values.url);
  } catch {
    throw new UsageError(`--url "${values.url}" is not a valid URL.`);
  }
  if (!LOCAL_HOSTNAMES.has(parsedUrl.hostname) && !values['i-understand-this-is-production']) {
    throw new UsageError(
      `--url "${values.url}" is not local. A load run posts thousands of messages and opens ` +
        'thousands of streams; pass --i-understand-this-is-production to run it against a real host.'
    );
  }

  const positiveInt = (name: string, raw: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw new UsageError(`--${name} must be a non-negative integer, got "${raw}".`);
    }
    return n;
  };

  const readers = positiveInt('readers', values.readers);
  const writers = positiveInt('writers', values.writers);
  const ratePerSecond = positiveInt('rate', values.rate);
  const durationSeconds = positiveInt('duration', values.duration);
  if (writers === 0 && readers === 0) throw new UsageError('Need at least one reader or writer.');
  if (ratePerSecond > 0 && writers === 0)
    throw new UsageError('--rate needs at least one --writers to post through.');

  // Reader shares report progress once a second; a shorter quiet window would read a stream that
  // is still receiving as silent between two reports.
  const quietMs = positiveInt('quiet-ms', values['quiet-ms']);
  if (quietMs < MIN_QUIET_MS) throw new UsageError(`--quiet-ms must be at least ${MIN_QUIET_MS}.`);

  const partMatch = /^(\d+)\/(\d+)$/.exec(values.part);
  const part = partMatch ? { index: Number(partMatch[1]), count: Number(partMatch[2]) } : null;
  if (!part || part.count < 1 || part.index < 1 || part.index > part.count)
    throw new UsageError(`--part must look like 2/3 (part 2 of 3), got "${values.part}".`);
  if (values['fixture-out'] && values.fixture)
    throw new UsageError('Use --fixture-out to seed, or --fixture to run, not both.');
  if (part.count > 1 && !values.fixture)
    throw new UsageError(
      '--part needs --fixture: seed once with --fixture-out, then give every part that file.'
    );
  let startAt: number | undefined;
  if (values['start-at'] !== undefined) {
    startAt = Date.parse(values['start-at']);
    if (Number.isNaN(startAt))
      throw new UsageError(`--start-at must be an ISO 8601 time, got "${values['start-at']}".`);
  }

  const warnings: string[] = [];
  const perWriter = writers
    ? Math.ceil((ratePerSecond * Math.min(durationSeconds, 600)) / writers)
    : 0;
  if (perWriter > DEFAULT_POSTS_PER_MEMBER_PER_TEN_MINUTES) {
    warnings.push(
      `Each writer posts about ${perWriter} times in ten minutes; the server's default limit is ` +
        `${DEFAULT_POSTS_PER_MEMBER_PER_TEN_MINUTES} per member, so later posts will be refused (429). ` +
        'Add --writers, or raise COMMUNITY_POSTS_PER_TEN_MINUTES on the target.'
    );
  }

  return {
    url: values.url.replace(/\/+$/, ''),
    readers,
    writers,
    ratePerSecond,
    durationSeconds,
    communityName: values['community-name'],
    channelName: values['channel-name'],
    out: values.out,
    quietMs,
    drainTimeoutSeconds: positiveInt('drain-timeout', values['drain-timeout']),
    readerThreads:
      values['reader-threads'] === 'auto'
        ? 'auto'
        : positiveInt('reader-threads', values['reader-threads']),
    openTimeoutSeconds: positiveInt('open-timeout', values['open-timeout']),
    fixtureOut: values['fixture-out'],
    fixture: values.fixture,
    part,
    startAt,
    warnings,
  };
}
