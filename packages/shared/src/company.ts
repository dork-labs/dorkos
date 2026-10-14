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
 * The postal address is published because the DorkOS Cloud terms name it
 * (DOR-2556). Pages render it with {@link formatCompanyAddress}, never by
 * typing it.
 *
 * Brand URLs (the site, docs, GitHub and npm) live beside this module in
 * `@dorkos/shared/links`.
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
  /** The state whose law governs the legal terms, and whose courts hear disputes. */
  governingState: 'Texas',
  /**
   * The company's published email addresses. Files that cannot import this
   * module (`SECURITY.md`, `CODE_OF_CONDUCT.md`, the marketplace registry
   * JSON) hold the literal, pinned by the company test.
   */
  emails: {
    /** The general contact address the site and legal pages publish. */
    contact: 'hey@dorkos.ai',
    /** Where customers reach support about DorkOS Cloud and their account. */
    support: 'support@dorkos.ai',
    /** Where security vulnerabilities and conduct reports go. */
    security: 'security@dorkos.ai',
    /** The owner contact the Dork Labs marketplace registry publishes. */
    marketplace: 'hello@dorkos.ai',
  },
  /** The company's registered postal address. */
  address: {
    street: '6028 Toscana Ave',
    city: 'Austin',
    /** The two-letter state code. */
    region: 'TX',
    postalCode: '78724',
    country: 'United States',
  },
} as const;

/** The shape of {@link company}. */
export type Company = typeof company;

/** The shape of {@link company}'s email addresses. */
export type CompanyEmails = Company['emails'];

/** The shape of {@link company}'s postal address. */
export type CompanyAddress = Company['address'];

/**
 * The postal address on one line, as a legal page prints it:
 * "6028 Toscana Ave, Austin, TX 78724, United States".
 *
 * @param address - The address to format; defaults to the company's own.
 * @param options - Set `country: false` to leave the country off.
 */
export function formatCompanyAddress(
  address: CompanyAddress = company.address,
  options: { country?: boolean } = {}
): string {
  const line = `${address.street}, ${address.city}, ${address.region} ${address.postalCode}`;
  return options.country === false ? line : `${line}, ${address.country}`;
}

/** The year the copyright notices name. */
export const COPYRIGHT_YEAR = 2026;

/** The copyright notice shown in app metadata, such as the desktop About panel. */
export const COPYRIGHT_NOTICE = `© ${COPYRIGHT_YEAR} ${company.legalName}`;
