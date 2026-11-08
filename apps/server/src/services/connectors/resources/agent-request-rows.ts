/** Reading the JSON columns an agent service request row stores. */
import type { ConnectorEventGrantSelection } from '@dorkos/shared/connector-event-schemas';

/** A stored JSON list of strings; anything else reads as empty. */
export function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return [];
  return parsed;
}

/** The updates an answer chose, and the hash they were applied under once live. */
export interface ResolvedEventSelectionEnvelope {
  readonly version: 1;
  readonly selections: ConnectorEventGrantSelection[];
  readonly appliedEventScopeHash?: string;
}

/** An answer that chose no updates. */
export function emptyEventSelection(): ResolvedEventSelectionEnvelope {
  return { version: 1, selections: [] };
}

/** A stored update selection; anything malformed reads as none. */
export function parseResolvedEventSelection(value: string | null): ResolvedEventSelectionEnvelope {
  if (!value) return emptyEventSelection();
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('selections' in parsed) ||
    !Array.isArray(parsed.selections)
  ) {
    return emptyEventSelection();
  }
  const selections = parsed.selections.filter(
    (selection): selection is ConnectorEventGrantSelection =>
      Boolean(
        selection &&
        typeof selection === 'object' &&
        'subscriptionId' in selection &&
        typeof selection.subscriptionId === 'string' &&
        'scopeVersion' in selection &&
        typeof selection.scopeVersion === 'number' &&
        'definitionId' in selection &&
        typeof selection.definitionId === 'string' &&
        'eventScopeHash' in selection &&
        typeof selection.eventScopeHash === 'string'
      )
  );
  const appliedEventScopeHash =
    'appliedEventScopeHash' in parsed && typeof parsed.appliedEventScopeHash === 'string'
      ? parsed.appliedEventScopeHash
      : undefined;
  return {
    version: 1,
    selections,
    ...(appliedEventScopeHash && { appliedEventScopeHash }),
  };
}
