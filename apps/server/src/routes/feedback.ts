/**
 * Feedback route (DOR-317, ADR 260713-143958 Phase 5).
 *
 * `POST /api/feedback` — receive a message the user deliberately wrote (general
 * feedback, a bug, or a feature idea) and forward it to the owned ingest via the
 * {@link sendFeedback} forwarder. Thin: validate the submission with Zod, fill in
 * the identity/version context server-side, and relay the forwarder's honest
 * `{ ok }` so the cockpit can toast truthfully.
 *
 * Deliberately independent of the telemetry consent channel and env kill
 * switches — pressing Send IS the consent (see the feedback-reporter and
 * `@dorkos/shared/telemetry-events` for the reasoning).
 *
 * @module routes/feedback
 */
import { Router } from 'express';
import { FeedbackSubmissionSchema } from '@dorkos/shared/telemetry-events';
import { sendFeedback } from '../services/core/feedback-reporter.js';
import { resolveDorkHome } from '../lib/dork-home.js';
import { SERVER_VERSION } from '../lib/version.js';

const router = Router();

/** POST /api/feedback — validate the submission and forward it to the ingest. */
router.post('/', async (req, res) => {
  const parsed = FeedbackSubmissionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid feedback', code: 'INVALID_FEEDBACK' });
  }

  const result = await sendFeedback({
    submission: parsed.data,
    dorkHome: resolveDorkHome(),
    dorkosVersion: SERVER_VERSION,
  });

  // Always 200 with an honest `ok` — a failed forward is not a client error to
  // retry; the UI reads `ok` to choose between "Thanks, sent." and the GitHub
  // fallback message.
  return res.json(result);
});

export default router;
