/**
 * The shape of one entry on the failure code list.
 *
 * @module shared/problem-codes/definition
 */

/** One failure code, with the status and title a response carries by default. */
export interface ProblemCodeDefinition {
  /** The machine-readable code, `lower_snake`. */
  readonly code: string;
  /** The HTTP status a response with this code carries unless the sender says otherwise. */
  readonly status: number;
  /** A short summary, safe to show a person. The same for every occurrence of the code. */
  readonly title: string;
}
