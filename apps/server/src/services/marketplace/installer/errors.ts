/**
 * The errors the marketplace installer throws for a package it refuses:
 * one that fails validation, one whose conflicts block it, and one that is
 * not the package a person approved.
 *
 * @module services/marketplace/installer/errors
 */
import type { ConflictReport } from '../types.js';

/**
 * Thrown when `@dorkos/marketplace/package-validator` reports one or more
 * error-level issues for the staged package. The full list of error
 * messages is preserved on {@link InvalidPackageError.errors} so HTTP
 * routes can surface them verbatim.
 */
export class InvalidPackageError extends Error {
  /**
   * Build an `InvalidPackageError` from a list of validator error messages.
   *
   * @param errors - Human-readable validation error messages.
   */
  constructor(public readonly errors: string[]) {
    super(`Package failed validation:\n${errors.join('\n')}`);
    this.name = 'InvalidPackageError';
  }
}

/**
 * Thrown when the permission preview contains one or more error-level
 * conflicts and the caller did not pass `force: true`. The full conflict
 * list (including warnings) is preserved on {@link ConflictError.conflicts}.
 */
export class ConflictError extends Error {
  /**
   * Build a `ConflictError` from the full conflict list produced by the
   * permission preview builder.
   *
   * @param conflicts - Every conflict the detector reported, including warnings.
   */
  constructor(public readonly conflicts: ConflictReport[]) {
    const errorLines = conflicts
      .filter((c) => c.level === 'error')
      .map((c) => `  - ${c.description}`)
      .join('\n');
    super(`Install blocked by conflicts:\n${errorLines}`);
    this.name = 'ConflictError';
  }
}

/**
 * Thrown when the package resolved for the INSTALL declares different executable
 * content than the one a person approved (DOR-647).
 *
 * The approval binding closes the window between the card and the retry. This
 * closes the one after it: `install()` resolves and stages the package a second
 * time, so a source that served A while the card was being read can serve B while
 * the install runs, and everything up to this point would still be consistent.
 * The comparison costs nothing — `install()` already builds a preview here for the
 * conflict gate — and it is the last point at which refusing still means nothing
 * has been written.
 *
 * Distinct from {@link ConflictError} and {@link InvalidPackageError} because it
 * is neither: the package is valid and uncontested, it is simply not the one that
 * was agreed to.
 */
export class DisclosureChangedError extends Error {
  /**
   * Build the error from what the person approved and what arrived instead.
   *
   * @param approved - Plain-language description of the disclosed effects the
   *   approval was bound to.
   * @param resolved - The same description for the package that just resolved.
   */
  constructor(
    public readonly approved: string,
    public readonly resolved: string
  ) {
    super(
      `This package is not the one that was approved. The approval covered ${approved}; the ` +
        `copy that resolved just now declares ${resolved}. Nothing was installed. Ask again to ` +
        `see what it declares now.`
    );
    this.name = 'DisclosureChangedError';
  }
}
