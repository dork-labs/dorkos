import { describe, expect, it } from 'vitest';
import {
  MIXED_SCRIPT_APP_NAME_MESSAGE,
  RESERVED_APP_NAME_MESSAGE,
  UNUSUAL_LETTER_APP_NAME_MESSAGE,
  normalizedAppName,
  reservedAppNameProblem,
} from '../index.js';

describe('reservedAppNameProblem', () => {
  it.each([
    ['DorkOS'],
    ['Dork OS'],
    ['Dorkos'],
    ['dork‑os'], // non-breaking hyphen
    ['Dork_OS.Helper'],
    ['DorkOS Marketplace'],
    ['Dork​OS'], // zero-width space
    ['‮DorkOS'], // bidi override
    ['ＤｏｒｋＯＳ'], // full width
    ['D0rkOS'],
    ['Settings'],
    ['settings '],
    ['INBOX'],
    ['Work spaces'],
    ['DorkBot'],
    ['ТЕАМ'], // Cyrillic capitals only
  ])('refuses %j as DorkOS’s own', (name) => {
    expect(reservedAppNameProblem(name)).toBe(RESERVED_APP_NAME_MESSAGE);
  });

  it('refuses a look-alike letter from another alphabet', () => {
    // Cyrillic о in the middle.
    expect(reservedAppNameProblem('DоrkOS')).toBe(RESERVED_APP_NAME_MESSAGE);
    // Greek iota.
    expect(reservedAppNameProblem('Settιngs')).toBe(RESERVED_APP_NAME_MESSAGE);
  });

  it.each([
    ['Dörkos'],
    ['DørkOS'],
    ['Séttings'],
    ['Inbóx'],
    ['Settıngs'], // dotless i
    ['lnbox'], // lower-case L for I
    ['1nbox'], // digit one for I
    ['Đorkos'],
    ['Ðorkos'],
    ['Marketpłace'],
  ])('refuses %j: accents and look-alike Latin letters fold away', (name) => {
    expect(reservedAppNameProblem(name)).toBe(RESERVED_APP_NAME_MESSAGE);
  });

  it.each([['Café Notes'], ['Ledger'], ['Planner'], ['Ølstue Log'], ['Łódź Trips']])(
    'allows %j: the fold is for the comparison only',
    (name) => {
      expect(reservedAppNameProblem(name)).toBeNull();
    }
  );

  // Purpose: the fold is for the reserved comparison only; the mixed-script
  // check reads the original letters, so folding a Cyrillic look-alike into
  // Latin never makes a mixed name pass.
  it('refuses a mixed name only the mixed-script check catches', () => {
    // Cyrillic о in a name that is not reserved: it folds to "notes".
    expect(normalizedAppName('Nоtes')).toBe('notes');
    expect(reservedAppNameProblem('Nоtes')).toBe(MIXED_SCRIPT_APP_NAME_MESSAGE);
    // Cyrillic е with an accent: the fold strips both, the check still sees it.
    expect(reservedAppNameProblem('Lеdgér')).toBe(MIXED_SCRIPT_APP_NAME_MESSAGE);
  });

  it('refuses a name mixing Latin with Cyrillic or Greek letters', () => {
    // A Cyrillic letter the look-alike table has no entry for.
    expect(reservedAppNameProblem('Notes ж')).toBe(MIXED_SCRIPT_APP_NAME_MESSAGE);
  });

  it.each([
    ['DorkOꓢ'], // Lisu
    ['ᎠorkOS'], // Cherokee
    ['Dօrk OS'], // Armenian
    ['Notes ノート'], // Japanese beside Latin
  ])('refuses %j: Latin mixed with letters of any other script', (name) => {
    expect(reservedAppNameProblem(name)).toBe(MIXED_SCRIPT_APP_NAME_MESSAGE);
  });

  it.each([
    ['ᴅᴏʀᴋᴏꜱ'], // small capitals
    ['Notes ʀ'], // IPA letter
    ['Notes ꜱ'], // Latin Extended-D
    ['Notes ᵃ'], // phonetic extension
  ])('refuses %j: small-capital and phonetic letters anywhere', (name) => {
    expect(reservedAppNameProblem(name)).toBe(UNUSUAL_LETTER_APP_NAME_MESSAGE);
  });

  it('drops a Hangul filler from the fold, so it cannot split a reserved name', () => {
    expect(normalizedAppName('Dork\u3164OS')).toBe('dorkos');
    expect(reservedAppNameProblem('Dork\u3164OS')).toBe(RESERVED_APP_NAME_MESSAGE);
  });

  it.each([['Notes\u3164Pad'], ['Notes\u115FPad'], ['Notes\u1160Pad'], ['Notes\uFFA0Pad']])(
    'refuses %j: a Hangul filler anywhere',
    (name) => {
      expect(reservedAppNameProblem(name)).toBe(UNUSUAL_LETTER_APP_NAME_MESSAGE);
    }
  );

  it.each([
    ['Notes'],
    ['Dork Notes'],
    ['My Inbox'],
    ['Team Notes'],
    ['Заметки'],
    ['Settings 2'],
    ['メモ帳'],
    ['Café Notes'],
  ])('allows %j', (name) => {
    expect(reservedAppNameProblem(name)).toBeNull();
  });

  it('runs NFKC before the look-alike fold, so width and compatibility forms are caught', () => {
    expect(normalizedAppName('ＤｏｒｋＯＳ')).toBe('dorkos');
    // Mathematical bold letters are compatibility forms of plain Latin ones.
    expect(reservedAppNameProblem('𝐃𝐨𝐫𝐤𝐎𝐒')).toBe(RESERVED_APP_NAME_MESSAGE);
    expect(reservedAppNameProblem('Ｓｅｔｔｉｎｇｓ')).toBe(RESERVED_APP_NAME_MESSAGE);
  });

  it.each([['s3-sync'], ['S3 Sync'], ['Notes 2025'], ['Base64 Tool']])(
    'allows %j: digits fold only for the reserved-name comparison, never the script check',
    (name) => {
      expect(reservedAppNameProblem(name)).toBeNull();
    }
  );

  it('folds spacing, case, width and punctuation the same way', () => {
    expect(normalizedAppName(' Dork -—OS ')).toBe('dorkos');
  });
});
