import type { PlaygroundSection } from '../playground-registry';

/** Table showcase sections for the Tables playground page. */
export const TABLES_SECTIONS: PlaygroundSection[] = [
  {
    id: 'basic-table',
    title: 'Basic Table',
    page: 'tables',
    category: 'Tables',
    keywords: ['table', 'basic', 'static', 'caption', 'footer', 'header', 'primitives'],
  },
  {
    id: 'sortable-data-table',
    title: 'Sortable Data Table',
    page: 'tables',
    category: 'Tables',
    keywords: ['sort', 'data', 'tanstack', 'column', 'ascending', 'descending', 'agent', 'fleet'],
  },
  {
    id: 'activity-log',
    title: 'Activity Log',
    page: 'tables',
    category: 'Tables',
    keywords: ['activity', 'log', 'event', 'feed', 'actor', 'category', 'badge', 'timeline'],
  },
  {
    id: 'task-run-history',
    title: 'Task Run History',
    page: 'tables',
    category: 'Tables',
    keywords: ['task', 'run', 'history', 'status', 'duration', 'schedule', 'cron', 'pulse'],
  },
  {
    id: 'row-selection',
    title: 'Row Selection',
    page: 'tables',
    category: 'Tables',
    keywords: ['select', 'checkbox', 'bulk', 'multi', 'check', 'row', 'selection'],
  },
  {
    id: 'empty-and-loading-states',
    title: 'Empty & Loading States',
    page: 'tables',
    category: 'Tables',
    keywords: ['empty', 'loading', 'skeleton', 'no results', 'placeholder', 'shimmer'],
  },
  {
    id: 'compact-and-striped',
    title: 'Compact & Striped',
    page: 'tables',
    category: 'Tables',
    keywords: ['compact', 'dense', 'striped', 'zebra', 'alternate', 'relay', 'log'],
  },
];
