import type { PlaygroundSection } from '../playground-registry';

/**
 * Form sections from FormsPage.
 *
 * Sources: FormShowcases (Primitives), ComposedFormShowcases (Composed).
 */
export const FORMS_SECTIONS: PlaygroundSection[] = [
  // FormShowcases — Primitives

  {
    id: 'segmentedcontrol',
    title: 'SegmentedControl',
    page: 'forms',
    category: 'Primitives',
    keywords: ['segmented', 'toggle', 'switch', 'radio', 'choice', 'trust', 'thumb', 'slide'],
  },
  {
    id: 'permissionstateswitch',
    title: 'PermissionStateSwitch',
    page: 'forms',
    category: 'Primitives',
    keywords: ['permission', 'blocked', 'ask', 'allowed', 'area', 'floor', 'switch'],
  },
  {
    id: 'command',
    title: 'Command',
    page: 'forms',
    category: 'Primitives',
    keywords: ['search', 'autocomplete', 'combobox', 'filter', 'cmdk', 'palette'],
  },
  {
    id: 'boundednumberinput',
    title: 'BoundedNumberInput',
    page: 'forms',
    category: 'Primitives',
    keywords: ['number', 'bounded', 'min', 'max', 'range', 'commit', 'integer', 'validation'],
  },
  // ComposedFormShowcases — Composed
  {
    id: 'timezonecombobox',
    title: 'TimezoneCombobox',
    page: 'forms',
    category: 'Composed',
    keywords: ['timezone', 'combobox', 'iana', 'select', 'search', 'tasks', 'schedule'],
  },
  {
    id: 'scanrootinput',
    title: 'ScanRootInput',
    page: 'forms',
    category: 'Composed',
    keywords: ['scan', 'root', 'path', 'chip', 'tag', 'directory', 'mesh', 'filesystem'],
  },
  {
    id: 'settingrow',
    title: 'SettingRow',
    page: 'forms',
    category: 'Composed',
    keywords: [
      'setting',
      'row',
      'toggle',
      'switch',
      'label',
      'description',
      'horizontal',
      'settings',
    ],
  },
  {
    id: 'passwordinput',
    title: 'PasswordInput',
    page: 'forms',
    category: 'Composed',
    keywords: ['password', 'input', 'visibility', 'toggle', 'eye', 'secret', 'field', 'auth'],
  },
  {
    id: 'pathinput',
    title: 'PathInput',
    page: 'forms',
    category: 'Composed',
    keywords: ['path', 'folder', 'directory', 'browse', 'input', 'field', 'composed'],
  },
  {
    id: 'fieldcard',
    title: 'FieldCard',
    page: 'forms',
    category: 'Composed',
    keywords: ['field', 'card', 'group', 'divider', 'section', 'composed'],
  },
  {
    id: 'collapsiblefieldcard',
    title: 'CollapsibleFieldCard',
    page: 'forms',
    category: 'Composed',
    keywords: ['collapsible', 'field', 'card', 'accordion', 'chevron', 'composed'],
  },
];
