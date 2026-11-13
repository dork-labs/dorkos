/** Stable broker refusals that a host may map to its own tool or UI errors. */
export class TabBrokerError extends Error {
  constructor(
    readonly code:
      | 'tab_locked'
      | 'tab_gone'
      | 'page_held'
      | 'handoff_active'
      | 'tab_limit'
      | 'queue_full'
      | 'url_blocked',
    message: string
  ) {
    super(message);
    this.name = 'TabBrokerError';
  }
}

/** Do not reveal which other owner holds the page. */
export function tabLocked(): TabBrokerError {
  return new TabBrokerError(
    'tab_locked',
    'That tab isn’t shared with this chat. Use this chat’s tab.'
  );
}

/** The person must open or share another tab before the agent can continue. */
export function tabGone(): TabBrokerError {
  return new TabBrokerError(
    'tab_gone',
    'That tab closed. Ask the person to open this chat’s browser.'
  );
}

/** A takeover fences observations and actions equally. */
export function pageHeld(): TabBrokerError {
  return new TabBrokerError('page_held', 'The person has this tab. Wait until they hand it back.');
}
