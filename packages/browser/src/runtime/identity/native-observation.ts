import { z } from 'zod';

const brand = z
  .object({ brand: z.string().min(1).max(128), version: z.string().max(128) })
  .strict();
export const NativeIdentitySchema = z
  .object({
    userAgent: z.string().min(1).max(2048),
    appVersion: z.string().min(1).max(2048),
    platform: z.string().min(1).max(128),
    secureContext: z.boolean(),
    metadata: z
      .object({
        brands: z.array(brand).max(16),
        mobile: z.boolean(),
        platform: z.string().max(128),
        fullVersionList: z.array(brand).max(16).optional(),
        uaFullVersion: z.string().max(128).optional(),
        architecture: z.string().max(128).optional(),
        bitness: z.string().max(128).optional(),
        model: z.string().max(128).optional(),
        platformVersion: z.string().max(128).optional(),
        wow64: z.boolean().optional(),
        formFactors: z.array(z.string().max(128)).max(16).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type NativeIdentity = z.infer<typeof NativeIdentitySchema>;
export interface NativeIdentityComparison {
  readonly status: 'pass' | 'fail' | 'unverified';
  readonly mismatchedFields: readonly string[];
  readonly unavailableFields: readonly string[];
}
const sorted = (values: readonly z.infer<typeof brand>[]) =>
  [...values].sort((a, b) => a.brand.localeCompare(b.brand) || a.version.localeCompare(b.version));
function parseBrands(value: string): z.infer<typeof brand>[] | null {
  // Consume the complete Structured Field list, never accept a matching substring
  // surrounded by malformed bytes or silently ignore an extra brand.
  const items = value.split(/,\s*/);
  const result = [];
  for (const item of items) {
    const match = /^"([^"\\]+)";v="([^"\\]*)"$/.exec(item);
    if (!match || [...item].some((character) => character.charCodeAt(0) < 32)) return null;
    result.push({ brand: match[1]!, version: match[2]! });
  }
  return result;
}
/** Compare actual emitted identity; omitted fields remain unavailable even for workers. */
export function compareNativeRequest(
  headers: Readonly<Record<string, string | undefined>>,
  baseline: NativeIdentity,
  negotiated: boolean
): NativeIdentityComparison {
  const native = NativeIdentitySchema.parse(baseline);
  const mismatchedFields: string[] = [],
    unavailableFields: string[] = [];
  if (headers['user-agent'] === undefined) unavailableFields.push('user-agent');
  else if (headers['user-agent'] !== native.userAgent) mismatchedFields.push('user-agent');
  if (!native.metadata)
    return {
      status: mismatchedFields.length ? 'fail' : 'unverified',
      mismatchedFields,
      unavailableFields: [...unavailableFields, 'native-userAgentData'],
    };
  const m = native.metadata;
  for (const name of ['brands', 'fullVersionList'] as const)
    if (m[name] === undefined || !m[name].length) unavailableFields.push(`native:${name}`);
  if (negotiated)
    for (const name of [
      'fullVersionList',
      'uaFullVersion',
      'architecture',
      'bitness',
      'model',
      'platformVersion',
      'wow64',
      'formFactors',
    ] as const)
      if (m[name] === undefined) unavailableFields.push(`native:${name}`);
  const expected: Record<string, string | readonly z.infer<typeof brand>[] | undefined> = {
    'sec-ch-ua': m.brands,
    'sec-ch-ua-mobile': m.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': JSON.stringify(m.platform),
    'sec-ch-ua-full-version-list': m.fullVersionList,
    'sec-ch-ua-full-version': JSON.stringify(m.uaFullVersion),
    'sec-ch-ua-arch': JSON.stringify(m.architecture),
    'sec-ch-ua-bitness': JSON.stringify(m.bitness),
    'sec-ch-ua-model': JSON.stringify(m.model),
    'sec-ch-ua-platform-version': JSON.stringify(m.platformVersion),
    'sec-ch-ua-wow64': m.wow64 === undefined ? undefined : m.wow64 ? '?1' : '?0',
    'sec-ch-ua-form-factors': m.formFactors?.map((value) => JSON.stringify(value)).join(', '),
  };
  for (const [name, actual] of Object.entries(headers)) {
    if (!name.startsWith('sec-ch-ua') || actual === undefined) continue;
    const wanted = expected[name];
    if (wanted === undefined) unavailableFields.push(`unsupported:${name}`);
    else if (typeof wanted === 'string') {
      if (actual !== wanted) mismatchedFields.push(name);
    } else {
      const observed = parseBrands(actual);
      if (!observed || JSON.stringify(sorted(observed)) !== JSON.stringify(sorted(wanted)))
        mismatchedFields.push(name);
    }
  }
  for (const [name, wanted] of Object.entries(expected)) {
    if (wanted === undefined || name === 'sec-ch-ua-full-version') continue;
    const required =
      negotiated || ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'].includes(name);
    if (required && headers[name] === undefined) unavailableFields.push(name);
  }
  return {
    status: mismatchedFields.length ? 'fail' : unavailableFields.length ? 'unverified' : 'pass',
    mismatchedFields,
    unavailableFields,
  };
}
/** Native lifecycle comparisons preserve engine conventions and every observed metadata field. */
export function compareNativeIdentity(
  baseline: NativeIdentity,
  observed: NativeIdentity
): NativeIdentityComparison {
  const a = NativeIdentitySchema.parse(baseline),
    b = NativeIdentitySchema.parse(observed);
  const mismatchedFields: string[] = [],
    unavailableFields: string[] = [];
  for (const name of ['userAgent', 'appVersion', 'platform', 'secureContext'] as const)
    if (a[name] !== b[name]) mismatchedFields.push(name);
  if (!a.metadata || !b.metadata) unavailableFields.push('native-userAgentData');
  else {
    const names = new Set<keyof NonNullable<NativeIdentity['metadata']>>([
      ...(Object.keys(a.metadata) as (keyof NonNullable<NativeIdentity['metadata']>)[]),
      ...(Object.keys(b.metadata) as (keyof NonNullable<NativeIdentity['metadata']>)[]),
      'fullVersionList',
      'uaFullVersion',
      'architecture',
      'bitness',
      'model',
      'platformVersion',
      'wow64',
      'formFactors',
    ]);
    for (const name of names) {
      const left = a.metadata[name],
        right = b.metadata[name];
      if (left === undefined || right === undefined) {
        unavailableFields.push(name);
        continue;
      }
      if (
        (name === 'brands' || name === 'fullVersionList') &&
        ((Array.isArray(left) && !left.length) || (Array.isArray(right) && !right.length))
      )
        unavailableFields.push(name);
      const normalize = (value: typeof left) =>
        Array.isArray(value) && (name === 'brands' || name === 'fullVersionList')
          ? sorted(value as z.infer<typeof brand>[])
          : value;
      if (JSON.stringify(normalize(left)) !== JSON.stringify(normalize(right)))
        mismatchedFields.push(name);
    }
  }
  return {
    status: mismatchedFields.length ? 'fail' : unavailableFields.length ? 'unverified' : 'pass',
    mismatchedFields,
    unavailableFields,
  };
}
