/**
 * NATS-style hierarchical subject matching for the Relay message bus.
 *
 * Implements the two wildcard tokens from the NATS subject spec:
 * - `*` matches exactly one token (a single dot-separated segment)
 * - `>` matches one or more remaining tokens (must appear last in a pattern)
 *
 * Subjects and patterns use dot (`.`) as the token separator.
 *
 * @module relay/subject-matcher
 */

// === Constants ===

/** Token separator for hierarchical subjects. */
const TOKEN_SEPARATOR = '.';

/** Wildcard that matches exactly one token. */
const SINGLE_WILDCARD = '*';

/** Wildcard that matches one or more remaining tokens (must be last). */
const MULTI_WILDCARD = '>';

/** Maximum number of tokens allowed in a subject or pattern. */
const MAX_TOKEN_COUNT = 16;

/** Regex for a valid literal token: alphanumeric, hyphens, and underscores. */
const VALID_TOKEN_RE = /^[a-zA-Z0-9_-]+$/;

// === Validation ===

/** Structured error returned by {@link validateSubject}. */
export interface SubjectValidationError {
  /** Human-readable description of what is wrong. */
  message: string;
  /** The subject or pattern that failed validation. */
  subject: string;
}

/**
 * Result of validating a subject or pattern string.
 *
 * `valid: true` means the string is safe to use in matching.
 * `valid: false` includes a `reason` with the validation error.
 */
export type SubjectValidationResult =
  | { valid: true }
  | { valid: false; reason: SubjectValidationError };

/**
 * Validate a subject or pattern string for use in the Relay bus.
 *
 * Rules:
 * - Must be a non-empty string
 * - Tokens are separated by `.`
 * - Each token must be a non-empty alphanumeric string (hyphens and underscores allowed),
 *   or the wildcard `*`, or the multi-wildcard `>`
 * - `>` may only appear as the final token
 * - No more than {@link MAX_TOKEN_COUNT} tokens
 *
 * @param subject - The subject or pattern string to validate
 * @returns A {@link SubjectValidationResult} indicating success or failure
 */
export function validateSubject(subject: string): SubjectValidationResult {
  if (typeof subject !== 'string' || subject.length === 0) {
    return {
      valid: false,
      reason: { message: 'Subject must be a non-empty string', subject },
    };
  }

  const tokens = subject.split(TOKEN_SEPARATOR);

  if (tokens.length > MAX_TOKEN_COUNT) {
    return {
      valid: false,
      reason: {
        message: `Subject exceeds maximum token count of ${MAX_TOKEN_COUNT}`,
        subject,
      },
    };
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === undefined || token.length === 0) {
      return {
        valid: false,
        reason: { message: 'Subject contains an empty token', subject },
      };
    }

    // `>` is only allowed as the last token
    if (token === MULTI_WILDCARD) {
      if (i !== tokens.length - 1) {
        return {
          valid: false,
          reason: {
            message: '`>` wildcard must be the last token in a subject',
            subject,
          },
        };
      }
      continue;
    }

    // `*` is a valid wildcard at any position
    if (token === SINGLE_WILDCARD) {
      continue;
    }

    // Literal token: must match the allowed character set
    if (!VALID_TOKEN_RE.test(token)) {
      return {
        valid: false,
        reason: {
          message: `Token "${token}" contains invalid characters (allowed: a-z, A-Z, 0-9, -, _)`,
          subject,
        },
      };
    }
  }

  return { valid: true };
}

// === Matching ===

/**
 * Test whether a concrete subject matches a pattern that may contain wildcards.
 *
 * Wildcard semantics (NATS-compatible):
 * - `*` in the pattern matches exactly one token in the subject
 * - `>` in the pattern (must be last) matches one or more remaining tokens
 * - All other tokens must match literally
 *
 * Both `subject` and `pattern` must pass {@link validateSubject} before being
 * passed here; this function does **not** re-validate its inputs for performance.
 * Callers that accept untrusted input should validate first.
 *
 * @param subject - A concrete (non-wildcard) subject, e.g. `relay.agent.myproject.backend`
 * @param pattern - A subject pattern that may include `*` or `>` wildcards
 * @returns `true` if the subject matches the pattern, `false` otherwise
 */
export function matchesPattern(subject: string, pattern: string): boolean {
  // An empty string has no tokens. `''.split('.')` would yield `['']` (one
  // empty-string element), so we normalise it to an empty array instead.
  const subjectTokens = subject.length === 0 ? [] : subject.split(TOKEN_SEPARATOR);
  const patternTokens = pattern.length === 0 ? [] : pattern.split(TOKEN_SEPARATOR);

  return matchTokens(subjectTokens, patternTokens, 0, 0);
}

/**
 * Recursive token-by-token matching engine.
 *
 * Using recursion keeps the logic simple and handles the `>` case cleanly.
 * Depth is bounded by {@link MAX_TOKEN_COUNT} (16), so no stack overflow risk.
 *
 * @param subject - All tokens of the subject string
 * @param pattern - All tokens of the pattern string
 * @param si - Current index into `subject`
 * @param pi - Current index into `pattern`
 */
function matchTokens(
  subject: readonly string[],
  pattern: readonly string[],
  si: number,
  pi: number
): boolean {
  // Both exhausted simultaneously → full match
  if (si === subject.length && pi === pattern.length) {
    return true;
  }

  // Pattern exhausted but subject still has tokens → no match
  if (pi === pattern.length) {
    return false;
  }

  const patternToken = pattern[pi];

  // `>` matches one or more remaining subject tokens
  if (patternToken === MULTI_WILDCARD) {
    // There must be at least one subject token left
    return si < subject.length;
  }

  // Subject exhausted but pattern still has non-`>` tokens → no match
  if (si === subject.length) {
    return false;
  }

  // `*` matches exactly one subject token (any value)
  if (patternToken === SINGLE_WILDCARD) {
    return matchTokens(subject, pattern, si + 1, pi + 1);
  }

  // Literal match required
  if (subject[si] !== patternToken) {
    return false;
  }

  return matchTokens(subject, pattern, si + 1, pi + 1);
}
