import { open, readFile, stat, lstat, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createSharedSANH2Origin } from './shared-san-h2-origin.fixture.js';

const absolute = z.string().min(1).refine(isAbsolute);
const hostname = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u);
const schema = z
  .object({
    keyPath: absolute,
    certificatePath: absolute,
    allowedHostname: hostname,
    deniedHostname: hostname,
    listenAddress: z.string().min(1).max(256),
    observationsPath: absolute,
  })
  .strict();

/** Operator-supplied certificate and two original public DNS subjects; grants no trust. */
export function readOriginalSharedSANEndpointConfig(value: unknown) {
  const config = schema.parse(value);
  for (const host of [config.allowedHostname, config.deniedHostname]) {
    if (host === 'localhost' || host.endsWith('.localhost') || /^[0-9.]+$/u.test(host))
      throw Error('H2_ROUTABLE_TRUSTED_ENDPOINT_REQUIRED');
  }
  if (config.allowedHostname === config.deniedHostname)
    throw Error('H2_DISTINCT_AUTHORITIES_REQUIRED');
  if ([config.keyPath, config.certificatePath].includes(config.observationsPath))
    throw Error('H2_OBSERVATION_DESTINATION_REFUSED');
  return Object.freeze(config);
}

async function bounded(path: string, limit: number) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > limit) throw Error('H2_ENDPOINT_INPUT_LIMIT');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw Error('H2_ENDPOINT_INPUT_LIMIT');
  return bytes;
}

/** Run on the controlled host. Only original signals or the fixed 180s bound retire the endpoint. */
export async function runOriginalSharedSANEndpoint(configPath: string) {
  if (!isAbsolute(configPath)) throw Error('H2_ENDPOINT_CONFIG_REQUIRED');
  const config = readOriginalSharedSANEndpointConfig(
    JSON.parse((await bounded(configPath, 16 * 1024)).toString('utf8'))
  );
  try {
    await lstat(config.observationsPath);
    throw Error('H2_OBSERVATION_DESTINATION_EXISTS');
  } catch (value) {
    if ((value as NodeJS.ErrnoException).code !== 'ENOENT') throw value;
  }
  const stagingPath = config.observationsPath + '.pending-' + randomUUID();
  const output = await open(stagingPath, 'wx', 0o600);
  let outputFailed = false;
  let first: { value: unknown } | undefined;
  let origin: Awaited<ReturnType<typeof createSharedSANH2Origin>> | undefined;
  const fail = (value: unknown) => {
    first ??= { value };
  };
  const throwOriginalFailure = () => {
    if (first) throw first.value;
  };
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closing = false;
  const stop = () => {
    closing = true;
    release();
  };
  const expired = () => {
    fail(Error('H2_ENDPOINT_DEADLINE'));
    stop();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    timer = setTimeout(expired, 180_000);
    const key = await bounded(config.keyPath, 256 * 1024);
    const certificate = await bounded(config.certificatePath, 256 * 1024);
    throwOriginalFailure();
    if (closing) throw Error('H2_ENDPOINT_STOPPED_BEFORE_LISTEN');
    origin = await createSharedSANH2Origin({
      key,
      certificate,
      allowedHostname: config.allowedHostname,
      deniedHostname: config.deniedHostname,
      listenAddress: config.listenAddress,
      listenPort: 443,
      browserCampaign: { onContinued: stop },
    });
    throwOriginalFailure();
    if (!closing) console.log('Original shared-SAN HTTPS endpoint listening on 443');
    await stopped;
  } catch (value) {
    fail(value);
  } finally {
    if (origin) {
      try {
        await origin.close();
      } catch (value) {
        fail(value);
      }
    }
    try {
      await output.writeFile(
        JSON.stringify({
          kind: 'original-shared-san-h2-endpoint',
          allowedHostname: config.allowedHostname,
          deniedHostname: config.deniedHostname,
          port: 443,
          observation: origin?.observation() ?? null,
          completed: first === undefined && origin !== undefined,
        }) + '\n'
      );
    } catch (value) {
      outputFailed = true;
      fail(value);
    }
    try {
      await output.sync();
    } catch (value) {
      outputFailed = true;
      fail(value);
    }
    try {
      await output.close();
    } catch (value) {
      outputFailed = true;
      fail(value);
    }
    if (!outputFailed) {
      try {
        await link(stagingPath, config.observationsPath);
      } catch (value) {
        fail(value);
      }
    }
    try {
      await unlink(stagingPath);
    } catch (value) {
      fail(value);
    }
    if (timer) clearTimeout(timer);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
  throwOriginalFailure();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runOriginalSharedSANEndpoint(process.argv[2] ?? '').catch((value: unknown) => {
    console.error(value === undefined ? 'Original endpoint failed: undefined' : value);
    process.exitCode = 1;
  });
}
