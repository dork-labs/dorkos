/**
 * The typed refusals a dev link answers with (DOR-2696). Each carries a code
 * from `DevLinkErrorCode`, the HTTP status the routes answer with, and one
 * plain sentence that says what did not happen and what to do instead.
 *
 * @module services/marketplace/dev-links/errors
 */
import { problemBody } from '@dorkos/http-kit';
import { isContained } from '../../../lib/boundary.js';
import type { DevLinkErrorCode } from '@dorkos/shared/marketplace-schemas';
import type { Problem, ProblemCode } from '@dorkos/shared/problem';

/**
 * The fixed sentence each dev-link refusal answers with. The error's own message
 * can name a folder or a slot on disk, so it stays in the server log and the
 * MCP tool result; an HTTP caller gets this, with the code as `reason` and the
 * structured details as extension members (DOR-4979).
 */
const DETAIL_BY_CODE: Record<DevLinkErrorCode, string> = {
  dev_link_path_not_real: 'That path is a link. Use the folder it points to.',
  dev_link_path_not_allowed: "That folder can't be linked. Pick another folder DorkOS may use.",
  dev_link_not_a_package: 'No valid package found in this folder.',
  dev_link_unsupported_type: 'Only plugins and skill packs can run from a folder.',
  dev_link_project_not_found: "That project wasn't found. Pick another one.",
  dev_link_exists: 'This package already runs from a dev link here. Unlink it first.',
  dev_link_slot_is_linked: 'This package is linked to another folder. Remove that link first.',
  dev_link_slot_taken: 'Something else is installed under that name. Remove it first.',
  dev_link_parked_exists: 'An earlier set-aside copy is still in place. Move it first.',
  dev_link_not_found: 'There is no dev link by that name.',
  dev_link_changed: 'The folder changed after you approved it. Ask again.',
  dev_link_card_too_long: "This folder runs too much to show on one card, so it can't be linked.",
  package_is_dev_linked: 'This package runs from a dev link. Unlink it first.',
};

/** The problem code each dev-link status answers with; the finer code rides as `reason`. */
const PROBLEM_CODE_BY_STATUS: Record<DevLinkError['status'], ProblemCode> = {
  400: 'invalid_request',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
};

/** A dev link refused, with the code and status the caller acts on. */
export class DevLinkError extends Error {
  /**
   * Build one refusal.
   *
   * @param code - The machine-readable refusal.
   * @param status - The HTTP status the routes answer with.
   * @param message - One plain sentence for the person or the agent.
   * @param details - Extra fields a caller can retry with (e.g. `realPath`).
   */
  constructor(
    readonly code: DevLinkErrorCode,
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'DevLinkError';
  }

  /** The structured result an MCP tool refuses with (not an HTTP body). */
  toBody(): Record<string, unknown> {
    return { error: this.message, code: this.code, ...this.details };
  }

  /**
   * The problem document a route answers with: a code by status, the dev
   * link's own refusal as `reason`, and its details as extension members.
   */
  toProblem(): Problem {
    return problemBody(PROBLEM_CODE_BY_STATUS[this.status], {
      detail: DETAIL_BY_CODE[this.code],
      status: this.status,
      extensions: { ...this.details, reason: this.code },
    });
  }
}

/**
 * The refusal an install, update or uninstall gets when the package's slot is
 * a dev link: those would replace or delete the link, and the explicit switch
 * is unlink.
 *
 * @param name - The package name.
 */
export function packageIsDevLinked(name: string): DevLinkError {
  return new DevLinkError(
    'package_is_dev_linked',
    409,
    `${name} runs from a dev link. Unlink it first.`,
    { name }
  );
}

/**
 * The refusal for a path that is a link: it names the real folder only when
 * the caller may use it, so a link pointing outside the boundary never reveals
 * where it leads (DOR-4979).
 *
 * @param real - The folder the link resolves to.
 * @param boundary - The directory boundary a linked folder must sit inside.
 */
export function notItsRealPath(real: string, boundary: string): DevLinkError {
  if (!isContained(real, boundary)) {
    return new DevLinkError(
      'dev_link_path_not_real',
      400,
      'That path is a link to a folder outside the folders DorkOS may use.'
    );
  }
  return new DevLinkError(
    'dev_link_path_not_real',
    400,
    `That path is a link. Use ${real} instead.`,
    {
      realPath: real,
    }
  );
}
