/**
 * The company behind DorkOS, in one place.
 *
 * Every page, panel or notice that names the legal entity reads it from here
 * rather than typing it, so a change of entity is one edit. Files that cannot
 * import TypeScript (`LICENSE`, `apps/desktop/electron-builder.yml`,
 * `apps/desktop/package.json`) hold the literal text, and
 * `packages/shared/src/__tests__/company.test.ts` fails when any of them
 * disagrees with this module.
 *
 * The company's postal address is intentionally not published in this public
 * repository, because no page here needs one yet. If a published legal page
 * comes to need it, that work adds it here as a field and the page reads it
 * from this module.
 *
 * @module shared/company
 */

/** Facts about the company that makes DorkOS. */
export const company = {
  /** The full legal name, as registered. Use it wherever a legal party is named. */
  legalName: '144 Studio, LLC',
  /** The name for running prose once the legal name has been given. */
  shortName: '144 Studio',
  /** Where the company is organized. */
  jurisdiction: 'Texas, United States',
  /** The kind of legal entity it is. */
  entityType: 'limited liability company',
  /** The general contact address the site and legal pages publish. */
  contactEmail: 'hey@dorkos.ai',
} as const;

/** The shape of {@link company}. */
export type Company = typeof company;

/** The year the copyright notices name. */
export const COPYRIGHT_YEAR = 2026;

/** The copyright notice shown in app metadata, such as the desktop About panel. */
export const COPYRIGHT_NOTICE = `© ${COPYRIGHT_YEAR} ${company.legalName}`;
