/**
 * Parser for `relay.human.*` subjects into adapter routing components.
 *
 * Shared by {@link BindingRouter} (inbound routing) and the DOR-277
 * initiate-consent gate so both resolve a human subject to the SAME
 * `{adapterId, chatId, channelType}` triple. Keeping one parser is a
 * correctness requirement: if the gate resolved a different binding than the
 * router, the consent decision would not match the message that is delivered.
 *
 * @module services/relay/human-subject
 */

/** Adapter routing components parsed from a `relay.human.*` subject. */
export interface ParsedHumanSubject {
  /** The adapter's unique instance id (the segment after the platform type). */
  adapterId?: string;
  /** The chat identifier, when present. */
  chatId?: string;
  /** `'group'` for group subjects; otherwise undefined (a DM). */
  channelType?: string;
}

/**
 * Parse a relay subject into adapter routing components.
 *
 * Expected patterns (instance-aware format):
 * - `relay.human.{platformType}.{instanceId}.{chatId}` (DM)
 * - `relay.human.{platformType}.{instanceId}.group.{chatId}` (group chat)
 *
 * The instance ID segment is the adapter's unique ID and is used directly as
 * the `adapterId` for binding resolution. Returns an empty object for any
 * subject that is not a parseable `relay.human.*` subject.
 *
 * @param subject - The relay subject to parse.
 */
export function parseHumanSubject(subject: string): ParsedHumanSubject {
  const parts = subject.split('.');
  if (parts[0] !== 'relay' || parts[1] !== 'human') return {};

  const platformType = parts[2];
  if (!platformType) return {};

  const remaining = parts.slice(3);

  // First remaining token is the instance ID (adapter ID)
  const instanceId = remaining[0];
  if (!instanceId) return {};

  const adapterId = instanceId;
  const afterInstance = remaining.slice(1);

  let chatId: string | undefined;
  let channelType: string | undefined;

  if (afterInstance.length >= 2 && afterInstance[0] === 'group') {
    channelType = 'group';
    chatId = afterInstance.slice(1).join('.');
  } else if (afterInstance.length >= 1) {
    chatId = afterInstance.join('.');
  }

  return { adapterId, chatId, channelType };
}
