/**
 * Each bundled mini app on a package card. Reads only preview declarations;
 * displaying them never grants access or creates a schedule.
 * @module services/marketplace/preview/extension-disclosure
 */
import { revealHiddenCharacters } from '@dorkos/shared/marketplace-schemas';
import { runsAnyProgram } from '@dorkos/shared/extension-approval-schemas';
import type { PreviewExtension } from '../types.js';
import { describeEffectsInFull, type DisclosedEffects } from './disclosed-effects.js';

/** Quote an entire declaration and reveal hidden characters. */
const whole = (value: string): string => revealHiddenCharacters(JSON.stringify(value));

/** Ordinary tokens read plainly; unusual values keep exact boundaries and visible escapes. */
const shown = (value: string): string =>
  /^[A-Za-z0-9_./:@*+-]+$/.test(value) ? value : whole(value);

/** One app's declared places and permissions, without secret values. */
export function extensionDeclarationLines(ext: PreviewExtension): string[] {
  const isolation = ext.isolation;
  return [
    `Shows in: ${ext.slots.length ? ext.slots.map(shown).join(', ') : 'no places declared'}`,
    ...(ext.hasServer === false
      ? ['Only screens; no server code.']
      : !isolation || isolation.runtime === 'in-process'
        ? ['May run server code inside DorkOS, with full access to this computer.']
        : [
            'Runs separately from DorkOS.',
            isolation.net.length
              ? `Can connect to: ${isolation.net.map(shown).join(', ')}`
              : 'Can’t connect to the internet.',
            isolation.run.length
              ? `Can run: ${isolation.run.map(shown).join(', ')}`
              : 'Can’t run programs.',
            ...isolation.run
              .filter(runsAnyProgram)
              .map((program) => `Can run ${shown(program)}, which can run any program.`),
            isolation.agents
              ? 'Can message your agents and start chats.'
              : 'Can’t message your agents or start chats.',
          ]),
    ...(ext.secrets === undefined
      ? ['Secret declarations were not included in this preview.']
      : ext.secrets.length === 0
        ? ['No secrets declared.']
        : ext.secrets.map(
            (secret) =>
              `Secrets: ${shown(secret.key)} (${secret.required ? 'required' : 'optional'})`
          )),
  ];
}

/**
 * Every app and package-level effect, with no empty promise hiding server code.
 *
 * @param effects - What the package runs on its own, or `null` when not previewed.
 * @param extensions - Its bundled apps, or `undefined` when not previewed.
 * @param where - When its own programs start, in words.
 * @param appNote - A line said under each app, e.g. that an update's new code waits.
 */
export function describePackageInFull(
  effects: DisclosedEffects | null,
  extensions: readonly PreviewExtension[] | undefined,
  where: string,
  appNote?: string
): string[] {
  const appLines =
    extensions === undefined
      ? ['  Mini app details were not included in this preview.']
      : extensions.flatMap((ext) => [
          `  Mini app ${whole(ext.id)}:`,
          ...[...extensionDeclarationLines(ext), ...(appNote ? [appNote] : [])].map(
            (line) => `    ${line}`
          ),
        ]);
  // Unknown old metadata is never evidence that there is no server half.
  const mayRunServer =
    extensions === undefined || extensions.some((ext) => ext.hasServer !== false);
  return [
    ...appLines,
    ...(effects === null
      ? ['  Background work details were not included in this preview.']
      : describeEffectsInFull(effects, where, mayRunServer)),
  ];
}
