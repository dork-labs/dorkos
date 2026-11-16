import { SessionConnectionAccessListShowcase } from './SessionConnectionAccessListShowcase';
import { ConnectionAccessCardShowcase } from './ConnectionAccessCardShowcase';
import { AgentRequestCardShowcase } from './AgentRequestCardShowcase';
import {
  ReadOnlyAccessDialogShowcase,
  ReadOnlyAgentRequestShowcase,
} from './ReadOnlyAccessShowcases';

/** Account-access demos, grouped so the broader Connections gallery stays bounded. */
export function ConnectionAccessShowcases() {
  return (
    <>
      <SessionConnectionAccessListShowcase />
      <ConnectionAccessCardShowcase />
      <ReadOnlyAccessDialogShowcase />
      <ReadOnlyAgentRequestShowcase />
      <AgentRequestCardShowcase />
    </>
  );
}
