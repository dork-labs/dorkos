import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@/layers/shared/ui';

/** One select trigger with a fixed list, so the rows below stay about their state. */
function DemoSelect(props: React.ComponentProps<typeof SelectTrigger> & { value?: string }) {
  const { value, ...trigger } = props;
  return (
    <Select defaultValue={value}>
      <SelectTrigger {...trigger}>
        <SelectValue placeholder="Pick a runtime" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="claude">Claude Code</SelectItem>
        <SelectItem value="codex">Codex</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** Every field state in one place: rest, hover, focus, invalid, disabled and read-only. */
export function FieldStatesShowcases() {
  return (
    <PlaygroundSection
      title="Field states"
      description="Every state a field can be in. Tab through for the ring; hover for the firmer edge."
    >
      <ShowcaseLabel>Help, then an error in the same slot</ShowcaseLabel>
      <ShowcaseDemo>
        <FieldGroup className="max-w-md">
          <Field>
            <FieldLabel htmlFor="states-rest">Website</FieldLabel>
            <Input id="states-rest" placeholder="https://example.com" aria-describedby="h-rest" />
            <FieldDescription id="h-rest">Shown on your profile.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="states-invalid">Website</FieldLabel>
            <Input
              id="states-invalid"
              defaultValue="example"
              aria-invalid
              aria-describedby="e-invalid"
            />
            <FieldDescription>Shown on your profile.</FieldDescription>
            <FieldError id="e-invalid">Enter a full URL, starting with https://</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="states-disabled">Disabled</FieldLabel>
            <Input id="states-disabled" defaultValue="Still readable" disabled />
          </Field>
          <Field>
            <FieldLabel htmlFor="states-readonly">Read-only</FieldLabel>
            <Input id="states-readonly" defaultValue="Select me to copy" readOnly />
          </Field>
        </FieldGroup>
      </ShowcaseDemo>

      <ShowcaseLabel>Textarea</ShowcaseLabel>
      <ShowcaseDemo>
        <FieldGroup className="max-w-md">
          <Textarea aria-label="Rest" placeholder="Write a note" />
          <Textarea aria-label="Invalid" defaultValue="Too short" aria-invalid />
          <Textarea aria-label="Disabled" defaultValue="Still readable" disabled />
          <Textarea aria-label="Read-only" defaultValue="Select me to copy" readOnly />
        </FieldGroup>
      </ShowcaseDemo>

      <ShowcaseLabel>Select trigger: default, compact, invalid, disabled</ShowcaseLabel>
      <ShowcaseDemo>
        <FieldGroup className="max-w-md">
          <DemoSelect aria-label="Default" />
          <DemoSelect aria-label="Compact" density="compact" value="codex" />
          <DemoSelect aria-label="Invalid" aria-invalid />
          <DemoSelect aria-label="Disabled" value="claude" disabled />
        </FieldGroup>
      </ShowcaseDemo>

      <ShowcaseLabel>Checkbox, radio and switch</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-col gap-3 max-md:gap-4">
          <Field orientation="horizontal" className="max-md:min-h-11">
            <Checkbox id="states-check" />
            <FieldContent>
              <FieldLabel htmlFor="states-check" className="font-normal">
                Off
              </FieldLabel>
            </FieldContent>
          </Field>
          <Field orientation="horizontal" className="max-md:min-h-11">
            <Checkbox id="states-check-on" defaultChecked />
            <FieldLabel htmlFor="states-check-on" className="font-normal">
              On
            </FieldLabel>
          </Field>
          <Field orientation="horizontal" className="max-md:min-h-11">
            <Checkbox id="states-check-invalid" aria-invalid aria-describedby="e-check" />
            <FieldContent>
              <FieldLabel htmlFor="states-check-invalid" className="font-normal">
                Accept the terms
              </FieldLabel>
              <FieldError id="e-check">Tick this box to go on.</FieldError>
            </FieldContent>
          </Field>
          <RadioGroup defaultValue="a" aria-label="Runtime">
            <div className="flex items-center gap-2 max-md:gap-3">
              <RadioGroupItem value="a" id="states-radio-a" />
              <Label htmlFor="states-radio-a" className="font-normal">
                Claude Code
              </Label>
            </div>
            <div className="flex items-center gap-2 max-md:gap-3">
              <RadioGroupItem value="b" id="states-radio-b" />
              <Label htmlFor="states-radio-b" className="font-normal">
                Codex
              </Label>
            </div>
            <div className="flex items-center gap-2 max-md:gap-3">
              <RadioGroupItem value="c" id="states-radio-c" disabled />
              <Label htmlFor="states-radio-c" className="font-normal">
                Disabled
              </Label>
            </div>
          </RadioGroup>
          <div className="flex items-center gap-3">
            <Switch aria-label="Off" />
            <Switch aria-label="On" defaultChecked />
            <Switch aria-label="Disabled" disabled />
          </div>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
