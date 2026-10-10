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
  /** Things worth saying before the run starts, none of which stops it. */
  warnings: string[];
}

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
    quietMs: positiveInt('quiet-ms', values['quiet-ms']),
    drainTimeoutSeconds: positiveInt('drain-timeout', values['drain-timeout']),
    readerThreads:
      values['reader-threads'] === 'auto'
        ? 'auto'
        : positiveInt('reader-threads', values['reader-threads']),
    openTimeoutSeconds: positiveInt('open-timeout', values['open-timeout']),
    warnings,
  };
}
