import { z } from 'zod';
import type { BrowserContext, Page } from 'playwright-core';
import {
  NativeIdentitySchema,
  compareNativeIdentity,
  compareNativeRequest,
  type NativeIdentity,
} from '../native-observation.js';

export const matrixSubjects = [
  'page',
  'reload',
  'popup',
  'oopif',
  'dedicated',
  'shared',
  'service',
] as const;
export const MatrixObservationSchema = z
  .object({
    subject: z.enum(matrixSubjects),
    stage: z.enum(['initial', 'negotiated']),
    identity: NativeIdentitySchema,
  })
  .strict();
export const MatrixObservationsSchema = z
  .array(MatrixObservationSchema)
  .length(14)
  .superRefine((values, ctx) => {
    for (const subject of matrixSubjects)
      for (const stage of ['initial', 'negotiated'] as const)
        if (
          values.filter((value) => value.subject === subject && value.stage === stage).length !== 1
        )
          ctx.addIssue({
            code: 'custom',
            message: 'Original context matrix is incomplete or repeated',
          });
  });
export type MatrixObservation = z.infer<typeof MatrixObservationSchema>;
export type MatrixRequest = Readonly<{
  subject: (typeof matrixSubjects)[number];
  stage: 'first' | 'initial' | 'negotiated';
  headers: Readonly<Record<string, string | undefined>>;
}>;

/** Compare actual JS and original HTTPS observations; missing native metadata never passes. */
export function qualifyFixtureOriginalMatrix(
  native: NativeIdentity,
  observations: unknown,
  requests: readonly MatrixRequest[]
) {
  const original = NativeIdentitySchema.parse(native);
  if (
    !original.secureContext ||
    !original.metadata ||
    !/\bHeadlessChrome\//u.test(original.userAgent)
  )
    throw new Error('CHROME_MATRIX_ORIGINAL_NATIVE_BASELINE_REQUIRED');
  const expected = NativeIdentitySchema.parse({
    ...original,
    userAgent: original.userAgent.replace(/\bHeadlessChrome\//u, 'Chrome/'),
    appVersion: original.appVersion.replace(/\bHeadlessChrome\//u, 'Chrome/'),
  });
  const values = MatrixObservationsSchema.parse(observations);
  for (const value of values)
    if (compareNativeIdentity(expected, value.identity).status !== 'pass')
      throw new Error('CHROME_MATRIX_JS_IDENTITY_NOT_QUALIFIED');
  for (const subject of matrixSubjects)
    for (const stage of ['first', 'initial', 'negotiated'] as const) {
      const originals = requests.filter(
        (value) => value.subject === subject && value.stage === stage
      );
      if (
        !originals.length ||
        originals.length > 4 ||
        originals.some(
          (value) =>
            compareNativeRequest(value.headers, expected, stage === 'negotiated').status !== 'pass'
        )
      )
        throw new Error('CHROME_MATRIX_HTTPS_IDENTITY_NOT_QUALIFIED');
    }
  return Object.freeze({
    javascriptObservations: values.length,
    httpsSubjects: matrixSubjects.length,
    status: 'qualified' as const,
  });
}

type Track = <T>(label: string, producer: () => Promise<T> | T) => Promise<T>;
/** Fixed private fixture script consumer. It reads first-script reports without rewriting navigator.
 * Every original SDK producer is registered before entry and fenced after each await/method lookup.
 * The owned supervisor's close independently retires the entire genuine browser/worker tree.
 */
export async function sampleFixtureOriginalMatrix(
  context: BrowserContext,
  fixtureURL: string,
  guard: () => void,
  track: Track
): Promise<MatrixObservation[]> {
  guard();
  const pages = context.pages.bind(context);
  guard();
  const originals = pages();
  guard();
  if (originals.length !== 1) throw new Error('CHROME_MATRIX_ORIGINAL_PAGE_CHANGED');
  const page = originals[0]!;
  const pageContext = page.context.bind(page),
    goto = page.goto.bind(page),
    reload = page.reload.bind(page),
    evaluate = page.evaluate.bind(page),
    popupEvent = page.waitForEvent.bind(page);
  const url = new URL('/identity/page', fixtureURL);
  if (url.protocol !== 'https:' || url.hostname !== 'identity-alpha.test')
    throw new Error('CHROME_MATRIX_ORIGINAL_HTTPS_REQUIRED');
  const before = () => {
    guard();
    if (pageContext() !== context) throw new Error('CHROME_MATRIX_ORIGINAL_PAGE_CHANGED');
    guard();
  };
  const read = async (subject: (typeof matrixSubjects)[number], target: Page = page) => {
    guard();
    const readOriginal = target.evaluate.bind(target);
    guard();
    const result = await track('matrix.' + subject + '.initial-script-reports', () => {
      guard();
      return readOriginal('globalThis.matrixOwnResult');
    });
    guard();
    const values = z.array(MatrixObservationSchema).length(2).parse(result);
    if (values.some((value) => value.subject !== subject))
      throw new Error('CHROME_MATRIX_FOREIGN_SCRIPT_REPORT');
    return values;
  };
  before();
  await track('matrix.Page.goto', () => {
    before();
    return goto(url.href, { waitUntil: 'load', timeout: 10000 });
  });
  before();
  const values = await read('page');
  before();
  const workers = await track('matrix.Page.fixed-worker-cohort', () => {
    before();
    return evaluate('globalThis.matrixRunWorkers()');
  });
  before();
  values.push(...z.array(MatrixObservationSchema).length(8).parse(workers));
  // Register the exact SDK popup receiver before the first window.open effect.
  const popup = track('matrix.Page.original-popup', () => {
    before();
    return popupEvent('popup', { timeout: 10000 });
  });
  void popup.catch(() => {});
  await track('matrix.Page.fixed-popup-birth', () => {
    before();
    return evaluate('globalThis.matrixOpenPopup()');
  });
  before();
  const originalPopup = await popup;
  guard();
  const load = originalPopup.waitForLoadState.bind(originalPopup);
  guard();
  await track('matrix.Popup.initial-load', () => {
    guard();
    return load('load', { timeout: 10000 });
  });
  guard();
  values.push(...(await read('popup', originalPopup)));
  before();
  await track('matrix.Page.reload', () => {
    before();
    return reload({ waitUntil: 'load', timeout: 10000 });
  });
  before();
  values.push(...(await read('reload')));
  before();
  return MatrixObservationsSchema.parse(values);
}
