/**
 * Slack adapter module.
 *
 * @module relay/adapters/slack
 */
export {
  SlackAdapter,
  SLACK_MANIFEST,
  findPlatformError,
  classifySlackError,
} from './slack-adapter.js';
export type { SlackErrorClassification } from './slack-adapter.js';
