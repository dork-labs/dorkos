/**
 * One labelled control in a form, and the parts that surround it.
 *
 * The substrate `SettingRow` and every settings surface is built on, so the ten
 * parts are worth learning once. Nesting, outermost first:
 *
 * ```tsx
 * <FieldSet>                    // a titled set of related fields
 *   <FieldLegend>Alerts</FieldLegend>
 *   <FieldGroup>                // the stack that spaces fields apart
 *     <Field orientation="horizontal">   // ONE control and its words
 *       <FieldContent>          // the text column, when a control sits beside it
 *         <FieldLabel>Ping me</FieldLabel>
 *         <FieldDescription>When a turn finishes.</FieldDescription>
 *       </FieldContent>
 *       <Switch />
 *     </Field>
 *     <FieldSeparator />        // a rule between two groups of fields
 *     <FieldError errors={…} /> // the problem, announced
 *   </FieldGroup>
 * </FieldSet>
 * ```
 *
 * The parts find each other through `data-slot`, not through context: `Field`'s
 * horizontal layout keys off `[data-slot=field-content]`, `FieldSet` tightens
 * its gap when it holds a checkbox or radio group. A part that loses its
 * `data-slot` stops participating in that layout silently, so keep them.
 *
 * @module shared/ui/field
 */
import { useMemo } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/layers/shared/lib/utils';
import { Label } from '@/layers/shared/ui/label';
import { Separator } from '@/layers/shared/ui/separator';

/**
 * A titled set of related fields — the `<fieldset>` a screen reader groups by.
 *
 * Tightens its own spacing when it holds a checkbox or radio group, since those
 * read as one list rather than as separate questions.
 */
function FieldSet({ className, ...props }: React.ComponentProps<'fieldset'>) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn(
        'flex flex-col gap-6',
        'has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3',
        className
      )}
      {...props}
    />
  );
}

/**
 * The heading on a {@link FieldSet}.
 *
 * `variant="label"` drops it to the size of a field label, for a set nested
 * inside another one where a full heading would out-shout its parent.
 */
function FieldLegend({
  className,
  variant = 'legend',
  ...props
}: React.ComponentProps<'legend'> & { variant?: 'legend' | 'label' }) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        'mb-3 font-medium',
        'data-[variant=legend]:text-base',
        'data-[variant=label]:text-sm',
        className
      )}
      {...props}
    />
  );
}

/**
 * The stack that spaces a run of {@link Field}s apart.
 *
 * Also the container query `Field`'s `orientation="responsive"` measures, so a
 * field only goes side-by-side when this group is genuinely wide — which is the
 * group's width, not the window's.
 */
function FieldGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        'group/field-group @container/field-group flex w-full flex-col gap-7 data-[slot=checkbox-group]:gap-3 [&>[data-slot=field-group]]:gap-4',
        className
      )}
      {...props}
    />
  );
}

const fieldVariants = cva('group/field flex w-full gap-3 data-[invalid=true]:text-destructive', {
  variants: {
    orientation: {
      vertical: ['flex-col [&>*]:w-full [&>.sr-only]:w-auto'],
      horizontal: [
        'flex-row items-center',
        '[&>[data-slot=field-label]]:flex-auto',
        'has-[>[data-slot=field-content]]:items-start has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
      ],
      responsive: [
        'flex-col @md/field-group:flex-row @md/field-group:items-center [&>*]:w-full @md/field-group:[&>*]:w-auto [&>.sr-only]:w-auto',
        '@md/field-group:[&>[data-slot=field-label]]:flex-auto',
        '@md/field-group:has-[>[data-slot=field-content]]:items-start @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
      ],
    },
  },
  defaultVariants: {
    orientation: 'vertical',
  },
});

/**
 * One question and its answer — the unit everything else in this file surrounds.
 *
 * `orientation` decides where the control sits: `vertical` stacks it under the
 * label, `horizontal` puts it beside, `responsive` starts stacked and goes
 * side-by-side once the enclosing {@link FieldGroup} is wide enough. Marking it
 * `data-invalid` turns the whole field, label included, destructive.
 */
function Field({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof fieldVariants>) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  );
}

/**
 * The text column beside a control in a horizontal {@link Field}.
 *
 * Holds the label and its description so they stay one block while the switch
 * or checkbox floats to the other edge. Its presence is what tells `Field` to
 * top-align the control instead of centring it, so leave it out when the field
 * is a plain stacked input.
 */
function FieldContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-content"
      className={cn('group/field-content flex flex-1 flex-col gap-1.5 leading-snug', className)}
      {...props}
    />
  );
}

/**
 * The words naming a control, wired to it so clicking them focuses it.
 *
 * A real `<label>` — use it whenever there is an input to point at, and reach
 * for {@link FieldTitle} only when there isn't. Wrapping a whole {@link Field}
 * inside it turns the field into a selectable card that highlights when the
 * control it contains is checked.
 */
function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="field-label"
      className={cn(
        'group/field-label peer/field-label flex w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-50',
        'has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col has-[>[data-slot=field]]:rounded-md has-[>[data-slot=field]]:border [&>*]:data-[slot=field]:p-4',
        'has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5 dark:has-data-[state=checked]:bg-primary/10',
        className
      )}
      {...props}
    />
  );
}

/**
 * A field's heading when there is no single control to label.
 *
 * Looks exactly like {@link FieldLabel} but renders a `<div>`, so it never
 * claims to point at an input it cannot focus — the right choice above a group
 * of checkboxes or a block of read-only detail.
 */
function FieldTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-label"
      className={cn(
        'flex w-fit items-center gap-2 text-sm leading-snug font-medium group-data-[disabled=true]/field:opacity-50',
        className
      )}
      {...props}
    />
  );
}

/**
 * The quiet sentence under a label saying what the setting does.
 *
 * One short line, not a paragraph: if it needs more, the detail belongs behind
 * a link or a disclosure rather than in the row. Links inside it are underlined
 * and pick up the primary colour on hover.
 */
function FieldDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        'text-muted-foreground text-sm leading-normal font-normal group-has-[[data-orientation=horizontal]]/field:text-balance',
        'last:mt-0 nth-last-2:-mt-1 [[data-variant=legend]+&]:-mt-1.5',
        '[&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4',
        className
      )}
      {...props}
    />
  );
}

/**
 * A rule between two runs of fields, optionally with a word sitting on it.
 *
 * Pass children for the word — "or", usually — and it is drawn centred on the
 * line with the page colour behind it. With no children it is a plain hairline.
 */
function FieldSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  children?: React.ReactNode;
}) {
  return (
    <div
      data-slot="field-separator"
      data-content={!!children}
      className={cn(
        'relative -my-2 h-5 text-sm group-data-[variant=outline]/field-group:-mb-2',
        className
      )}
      {...props}
    >
      <Separator className="absolute inset-0 top-1/2" />
      {children && (
        <span
          className="bg-background text-muted-foreground relative mx-auto block w-fit px-2"
          data-slot="field-separator-content"
        >
          {children}
        </span>
      )}
    </div>
  );
}

/**
 * What went wrong, announced to a screen reader the moment it appears.
 *
 * Give it `children` for one hand-written message, or `errors` to render a
 * validator's list — duplicates are collapsed, one message renders as a line and
 * several as a bulleted list. Renders nothing at all when there is no problem,
 * so it can stay mounted in the field.
 */
function FieldError({
  className,
  children,
  errors,
  ...props
}: React.ComponentProps<'div'> & {
  errors?: Array<{ message?: string } | undefined>;
}) {
  const content = useMemo(() => {
    if (children) {
      return children;
    }

    if (!errors?.length) {
      return null;
    }

    const uniqueErrors = [...new Map(errors.map((error) => [error?.message, error])).values()];

    if (uniqueErrors?.length == 1) {
      return uniqueErrors[0]?.message;
    }

    return (
      <ul className="ml-4 flex list-disc flex-col gap-1">
        {uniqueErrors.map((error, index) => error?.message && <li key={index}>{error.message}</li>)}
      </ul>
    );
  }, [children, errors]);

  if (!content) {
    return null;
  }

  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn('text-destructive text-sm font-normal', className)}
      {...props}
    >
      {content}
    </div>
  );
}

export {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
};
