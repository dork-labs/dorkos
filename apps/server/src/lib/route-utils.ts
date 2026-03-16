/**
 * Shared route handler utilities for validation, error extraction, and boundary checks.
 *
 * @module lib/route-utils
 */
import type { Response } from 'express';
import type { ZodSchema } from 'zod';
import { z } from 'zod';
import { validateBoundary, BoundaryError } from './boundary.js';

const uuidSchema = z.string().uuid();

/**
 * Parse and validate a request body against a Zod schema.
 *
 * Returns the validated data on success, or `null` after sending a 400 response on failure.
 *
 * @param schema - Zod schema to validate against
 * @param data - Raw request data (body or query)
 * @param res - Express response object (used to send 400 on failure)
 * @returns Validated data or null if validation failed (response already sent)
 */
export function parseBody<T>(schema: ZodSchema<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    return null;
  }
  return result.data;
}

/**
 * Extract a human-readable error message from an unknown caught value.
 *
 * @param err - Caught error value
 * @param fallback - Default message when err is not an Error instance
 */
export function toErrorMessage(err: unknown, fallback = 'Internal server error'): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Validate that a string is a valid UUID.
 *
 * @param id - The string to validate
 * @returns The validated UUID string, or `null` if invalid
 */
export function parseSessionId(id: string): string | null {
  const result = uuidSchema.safeParse(id);
  return result.success ? result.data : null;
}

/**
 * Send a standardized JSON error response.
 *
 * @param res - Express response object
 * @param status - HTTP status code
 * @param message - Human-readable error message
 * @param code - Machine-readable error code
 */
export function sendError(res: Response, status: number, message: string, code: string): void {
  res.status(status).json({ error: message, code });
}

/**
 * Validate that a path is within the directory boundary.
 *
 * Sends a 403 response if the path violates the boundary and returns `false`.
 * Returns `true` if the path is valid or not provided.
 *
 * @param pathToCheck - User-supplied path (skipped if undefined/null)
 * @param res - Express response object (used to send 403 on violation)
 * @returns `true` if the path is valid, `false` if a 403 was sent
 */
export async function assertBoundary(
  pathToCheck: string | undefined | null,
  res: Response,
): Promise<boolean> {
  if (!pathToCheck) return true;
  try {
    await validateBoundary(pathToCheck);
    return true;
  } catch (err) {
    if (err instanceof BoundaryError) {
      res.status(403).json({ error: err.message, code: err.code });
      return false;
    }
    throw err;
  }
}
