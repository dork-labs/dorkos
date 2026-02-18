import { useState } from 'react';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';
import type { CreateItemRequest, UpdateItemRequest } from '@dorkos/shared/roadmap-schemas';

// === Types ===

/** Shape of the form's controlled state. */
interface FormFields {
  title: string;
  description: string;
  type: RoadmapItem['type'];
  moscow: RoadmapItem['moscow'];
  status: RoadmapItem['status'];
  health: RoadmapItem['health'];
  timeHorizon: RoadmapItem['timeHorizon'];
  effort: string;
  labels: string;
  startDate: string;
  endDate: string;
}

interface ItemFormProps {
  /** Initial values to pre-fill the form (edit mode). Omit for create mode. */
  initialValues?: Partial<RoadmapItem>;
  /** Whether a submission is in progress. */
  isSubmitting: boolean;
  /** Called with the validated payload when the user submits. */
  onSubmit: (data: CreateItemRequest | UpdateItemRequest) => void;
  /** When provided, a red Delete button is shown. Called when clicked. */
  onDelete?: () => void;
}

// === Option constants ===

const TYPE_OPTIONS: RoadmapItem['type'][] = [
  'feature',
  'bugfix',
  'technical-debt',
  'research',
  'epic',
];

const MOSCOW_OPTIONS: RoadmapItem['moscow'][] = [
  'must-have',
  'should-have',
  'could-have',
  'wont-have',
];

const STATUS_OPTIONS: RoadmapItem['status'][] = [
  'not-started',
  'in-progress',
  'completed',
  'on-hold',
];

const HEALTH_OPTIONS: RoadmapItem['health'][] = [
  'on-track',
  'at-risk',
  'off-track',
  'blocked',
];

const TIME_HORIZON_OPTIONS: RoadmapItem['timeHorizon'][] = ['now', 'next', 'later'];

// === Helpers ===

/** Convert an ISO datetime string to a date input value (YYYY-MM-DD). */
function isoToDateInput(iso?: string): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

/** Convert a date input value (YYYY-MM-DD) to an ISO datetime string, or undefined. */
function dateInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  return new Date(value).toISOString();
}

/** Build default form fields, optionally seeded from an existing item. */
function buildDefaults(initial?: Partial<RoadmapItem>): FormFields {
  return {
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    type: initial?.type ?? 'feature',
    moscow: initial?.moscow ?? 'should-have',
    status: initial?.status ?? 'not-started',
    health: initial?.health ?? 'on-track',
    timeHorizon: initial?.timeHorizon ?? 'next',
    effort: initial?.effort !== undefined ? String(initial.effort) : '',
    labels: initial?.labels?.join(', ') ?? '',
    startDate: isoToDateInput(initial?.startDate),
    endDate: isoToDateInput(initial?.endDate),
  };
}

/** Convert form fields to a request payload. */
function buildPayload(fields: FormFields): CreateItemRequest | UpdateItemRequest {
  return {
    title: fields.title.trim(),
    description: fields.description || undefined,
    type: fields.type,
    moscow: fields.moscow,
    status: fields.status,
    health: fields.health,
    timeHorizon: fields.timeHorizon,
    effort: fields.effort !== '' ? Number(fields.effort) : undefined,
    labels: fields.labels
      ? fields.labels.split(',').map((l) => l.trim()).filter(Boolean)
      : undefined,
    startDate: dateInputToIso(fields.startDate),
    endDate: dateInputToIso(fields.endDate),
  };
}

// === Component ===

const inputClass =
  'w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-400 disabled:opacity-50';

const labelClass = 'block text-xs font-medium text-neutral-600 mb-1';

/**
 * Controlled form for creating or editing a roadmap item.
 *
 * Manages all field state internally. Callers receive the validated payload
 * via `onSubmit` and may optionally provide an `onDelete` callback to show
 * a destructive delete action.
 */
export function ItemForm({ initialValues, isSubmitting, onSubmit, onDelete }: ItemFormProps) {
  const [fields, setFields] = useState<FormFields>(() => buildDefaults(initialValues));

  function setField<K extends keyof FormFields>(key: K, value: FormFields[K]) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!fields.title.trim() || isSubmitting) return;
    onSubmit(buildPayload(fields));
  }

  const isDisabled = !fields.title.trim() || isSubmitting;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* Title */}
      <div>
        <label htmlFor="item-title" className={labelClass}>
          Title <span className="text-red-500">*</span>
        </label>
        <input
          id="item-title"
          type="text"
          className={inputClass}
          value={fields.title}
          onChange={(e) => setField('title', e.target.value)}
          placeholder="Item title"
          required
          disabled={isSubmitting}
        />
      </div>

      {/* Description */}
      <div>
        <label htmlFor="item-description" className={labelClass}>
          Description
        </label>
        <textarea
          id="item-description"
          className={`${inputClass} resize-none`}
          rows={3}
          value={fields.description}
          onChange={(e) => setField('description', e.target.value)}
          placeholder="Optional description"
          disabled={isSubmitting}
        />
      </div>

      {/* Row: Type + MoSCoW */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="item-type" className={labelClass}>
            Type <span className="text-red-500">*</span>
          </label>
          <select
            id="item-type"
            className={inputClass}
            value={fields.type}
            onChange={(e) => setField('type', e.target.value as RoadmapItem['type'])}
            disabled={isSubmitting}
          >
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="item-moscow" className={labelClass}>
            MoSCoW <span className="text-red-500">*</span>
          </label>
          <select
            id="item-moscow"
            className={inputClass}
            value={fields.moscow}
            onChange={(e) => setField('moscow', e.target.value as RoadmapItem['moscow'])}
            disabled={isSubmitting}
          >
            {MOSCOW_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Row: Status + Health */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="item-status" className={labelClass}>
            Status <span className="text-red-500">*</span>
          </label>
          <select
            id="item-status"
            className={inputClass}
            value={fields.status}
            onChange={(e) => setField('status', e.target.value as RoadmapItem['status'])}
            disabled={isSubmitting}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="item-health" className={labelClass}>
            Health <span className="text-red-500">*</span>
          </label>
          <select
            id="item-health"
            className={inputClass}
            value={fields.health}
            onChange={(e) => setField('health', e.target.value as RoadmapItem['health'])}
            disabled={isSubmitting}
          >
            {HEALTH_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Row: Time Horizon + Effort */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="item-time-horizon" className={labelClass}>
            Time Horizon <span className="text-red-500">*</span>
          </label>
          <select
            id="item-time-horizon"
            className={inputClass}
            value={fields.timeHorizon}
            onChange={(e) =>
              setField('timeHorizon', e.target.value as RoadmapItem['timeHorizon'])
            }
            disabled={isSubmitting}
          >
            {TIME_HORIZON_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="item-effort" className={labelClass}>
            Effort (points)
          </label>
          <input
            id="item-effort"
            type="number"
            min={0}
            step={1}
            className={inputClass}
            value={fields.effort}
            onChange={(e) => setField('effort', e.target.value)}
            placeholder="e.g. 5"
            disabled={isSubmitting}
          />
        </div>
      </div>

      {/* Labels */}
      <div>
        <label htmlFor="item-labels" className={labelClass}>
          Labels (comma-separated)
        </label>
        <input
          id="item-labels"
          type="text"
          className={inputClass}
          value={fields.labels}
          onChange={(e) => setField('labels', e.target.value)}
          placeholder="e.g. backend, auth"
          disabled={isSubmitting}
        />
      </div>

      {/* Row: Start Date + End Date */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="item-start-date" className={labelClass}>
            Start Date
          </label>
          <input
            id="item-start-date"
            type="date"
            className={inputClass}
            value={fields.startDate}
            onChange={(e) => setField('startDate', e.target.value)}
            disabled={isSubmitting}
          />
        </div>
        <div>
          <label htmlFor="item-end-date" className={labelClass}>
            End Date
          </label>
          <input
            id="item-end-date"
            type="date"
            className={inputClass}
            value={fields.endDate}
            onChange={(e) => setField('endDate', e.target.value)}
            disabled={isSubmitting}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-2">
        {onDelete ? (
          <button
            type="button"
            onClick={onDelete}
            disabled={isSubmitting}
            className="rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
          >
            Delete
          </button>
        ) : (
          <span />
        )}
        <button
          type="submit"
          disabled={isDisabled}
          className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isSubmitting ? 'Saving...' : 'Save'}
        </button>
      </div>
    </form>
  );
}
