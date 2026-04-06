import * as React from 'react';
import { Field, FieldContent, FieldDescription, FieldLabel } from './field';
import { cn } from '@/layers/shared/lib';
import { Switch } from './switch';

interface SettingRowProps {
  /** Label content displayed on the left. Accepts strings or React nodes (e.g., icon + text). */
  label: React.ReactNode;
  /** Description text below the label. */
  description: string;
  /** Control element (Switch, Button, Select, etc.) rendered on the right (horizontal) or below (vertical). */
  children: React.ReactNode;
  /**
   * Layout orientation. Use `"horizontal"` for compact controls like Switch and
   * badges. Use `"vertical"` for wider controls like text inputs, number inputs,
   * and select dropdowns that benefit from full-width layout.
   *
   * @default "horizontal"
   */
  orientation?: 'horizontal' | 'vertical';
  /** Optional className for the outer Field wrapper. */
  className?: string;
}

/**
 * Settings row — label and description paired with a control element.
 *
 * Horizontal mode: label on the left, control on the right (compact controls).
 * Vertical mode: label on top, control below at full width (wide controls).
 *
 * Built on Shadcn Field for accessible label/description association.
 */
function SettingRow({
  label,
  description,
  children,
  orientation = 'horizontal',
  className,
}: SettingRowProps) {
  return (
    <Field
      orientation={orientation}
      className={cn(
        orientation === 'horizontal' ? 'items-center justify-between gap-4' : 'gap-1.5',
        className
      )}
    >
      <FieldContent className="min-w-0">
        <FieldLabel className="text-sm font-medium">{label}</FieldLabel>
        <FieldDescription className="text-xs">{description}</FieldDescription>
      </FieldContent>
      {children}
    </Field>
  );
}

interface SwitchSettingRowProps {
  /** Label text. */
  label: string;
  /** Description text below the label. */
  description: string;
  /** Switch checked state. */
  checked: boolean;
  /** Switch onCheckedChange handler. */
  onCheckedChange: (checked: boolean) => void;
  /** Optional aria-label override. Defaults to the label. */
  ariaLabel?: string;
  /** Optional className for the row. */
  className?: string;
  /** Optional disabled state. */
  disabled?: boolean;
}

/**
 * Switch + label row shorthand — the most common settings pattern.
 *
 * Wraps a `Switch` inside a `SettingRow` with consistent `aria-label`
 * defaulting and disabled state forwarding.
 */
function SwitchSettingRow({
  label,
  description,
  checked,
  onCheckedChange,
  ariaLabel,
  className,
  disabled,
}: SwitchSettingRowProps) {
  return (
    <SettingRow label={label} description={description} className={className}>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={ariaLabel ?? label}
        disabled={disabled}
      />
    </SettingRow>
  );
}

export { SettingRow, SwitchSettingRow };
export type { SettingRowProps, SwitchSettingRowProps };
