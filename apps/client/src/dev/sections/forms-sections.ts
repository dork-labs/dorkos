import type { PlaygroundSection } from '../playground-registry';

/**
 * Form sections from FormsPage.
 *
 * Sources: FormShowcases (Primitives), ComposedFormShowcases (Composed).
 */
export const FORMS_SECTIONS: PlaygroundSection[] = [
  // FormShowcases — Primitives
  {
    id: 'input',
    title: 'Input',
    page: 'forms',
    category: 'Primitives',
    keywords: ['text', 'field', 'form', 'type', 'placeholder', 'disabled'],
  },
  {
    id: 'textarea',
    title: 'Textarea',
    page: 'forms',
    category: 'Primitives',
    keywords: ['text', 'multiline', 'form', 'input', 'field'],
  },
  {
    id: 'switch',
    title: 'Switch',
    page: 'forms',
    category: 'Primitives',
    keywords: ['toggle', 'checkbox', 'boolean', 'on', 'off', 'setting'],
  },
  {
    id: 'select',
    title: 'Select',
    page: 'forms',
    category: 'Primitives',
    keywords: ['dropdown', 'picker', 'option', 'choice', 'form'],
  },
  {
    id: 'tabs',
    title: 'Tabs',
    page: 'forms',
    category: 'Primitives',
    keywords: ['tab', 'navigation', 'panel', 'switch', 'content'],
  },
  {
    id: 'checkbox',
    title: 'Checkbox',
    page: 'forms',
    category: 'Primitives',
    keywords: ['check', 'tick', 'multi-select', 'boolean', 'form', 'toggle'],
  },
  {
    id: 'radiogroup',
    title: 'RadioGroup',
    page: 'forms',
    category: 'Primitives',
    keywords: ['radio', 'single-select', 'option', 'choice', 'form', 'group'],
  },
  {
    id: 'label',
    title: 'Label',
    page: 'forms',
    category: 'Primitives',
    keywords: ['label', 'form', 'accessibility', 'input', 'htmlfor'],
  },
  {
    id: 'command',
    title: 'Command',
    page: 'forms',
    category: 'Primitives',
    keywords: ['search', 'autocomplete', 'combobox', 'filter', 'cmdk', 'palette'],
  },
  // ComposedFormShowcases — Composed
  {
    id: 'timezonecombobox',
    title: 'TimezoneCombobox',
    page: 'forms',
    category: 'Composed',
    keywords: ['timezone', 'combobox', 'iana', 'select', 'search', 'pulse', 'schedule'],
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
