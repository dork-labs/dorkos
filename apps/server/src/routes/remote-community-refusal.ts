/**
 * Route-facing entry point for Community refusal mapping. The mapping lives beside the remote
 * adapter so the outbox can use it too; routes keep importing it from here.
 *
 * @module routes/remote-community-refusal
 */
export {
  communityRefusal,
  type CommunityRefusal,
  type CommunityRefusalAction,
} from '../services/communities/remote/community-refusal.js';
