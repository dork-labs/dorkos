/**
 * Where the DorkOS Cloud `/v1` contract lives.
 *
 * Not the default `DORKOS_CLOUD_URL`: that is the website, which serves the
 * device link and the account pages but has no `/v1` routes, so every `/v1`
 * call sent there answered 404 (DOR-2673). Credits stream through this origin
 * too, so it must be the service itself, never a hop through the website.
 *
 * @module services/core/cloud/cloud-api-origin
 */
import { DEFAULT_CLOUD_URL } from '../auth/cloud-link-client.js';
import { env } from '../../../env.js';

/** The `/v1` origin when neither `DORKOS_CLOUD_API_URL` nor a custom `DORKOS_CLOUD_URL` is set. */
export const DEFAULT_CLOUD_API_URL = 'https://cloud.dorkos.ai';

const trimSlashes = (url: string): string => url.replace(/\/+$/, '');

/**
 * Resolve the origin every `/v1` call goes to, trailing slashes stripped.
 *
 * `DORKOS_CLOUD_API_URL` wins. Otherwise a `DORKOS_CLOUD_URL` that points
 * somewhere other than the default website is followed, because a local or
 * test service answers both surfaces on one origin. Otherwise the `/v1`
 * default, which is not the website's address.
 */
export function resolveCloudApiBaseUrl(): string {
  if (env.DORKOS_CLOUD_API_URL) return trimSlashes(env.DORKOS_CLOUD_API_URL);
  const cloudUrl = trimSlashes(env.DORKOS_CLOUD_URL);
  return cloudUrl && cloudUrl !== DEFAULT_CLOUD_URL ? cloudUrl : DEFAULT_CLOUD_API_URL;
}
