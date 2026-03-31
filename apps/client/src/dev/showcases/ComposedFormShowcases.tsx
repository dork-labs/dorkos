import { useState } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { TimezoneCombobox } from '@/layers/features/tasks/ui/TimezoneCombobox';
import { ScanRootInput } from '@/layers/entities/discovery';
import {
  Badge,
  CollapsibleFieldCard,
  FieldCard,
  FieldCardContent,
  SettingRow,
  PasswordInput,
  Switch,
} from '@/layers/shared/ui';

/** Composed form component showcases: TimezoneCombobox, ScanRootInput, SettingRow, PasswordInput, FieldCard, CollapsibleFieldCard. */
export function ComposedFormShowcases() {
  return (
    <>
      <TimezoneComboboxSection />
      <ScanRootInputSection />
      <SettingRowSection />
      <PasswordInputSection />
      <FieldCardSection />
      <CollapsibleFieldCardSection />
    </>
  );
}

// ---------------------------------------------------------------------------
// TimezoneCombobox
// ---------------------------------------------------------------------------

function TimezoneComboboxSection() {
  const [defaultTz, setDefaultTz] = useState('');
  const [explicitTz, setExplicitTz] = useState('America/New_York');

  return (
    <PlaygroundSection
      title="TimezoneCombobox"
      description="Searchable IANA timezone selector grouped by continent. Detects system timezone."
    >
      <ShowcaseLabel>Default (system timezone)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-xs">
          <TimezoneCombobox value={defaultTz} onChange={setDefaultTz} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>With explicit value</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-xs">
          <TimezoneCombobox value={explicitTz} onChange={setExplicitTz} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// ScanRootInput
// ---------------------------------------------------------------------------

function ScanRootInputSection() {
  const [populated, setPopulated] = useState(['/Users/kai/projects', '/opt/agents']);
  const [empty, setEmpty] = useState<string[]>([]);

  return (
    <PlaygroundSection
      title="ScanRootInput"
      description="Chip/tag input for filesystem scan paths with DirectoryPicker integration."
    >
      <ShowcaseLabel>With pre-populated paths</ShowcaseLabel>
      <ShowcaseDemo>
        <ScanRootInput roots={populated} onChange={setPopulated} />
      </ShowcaseDemo>

      <ShowcaseLabel>Empty</ShowcaseLabel>
      <ShowcaseDemo>
        <ScanRootInput roots={empty} onChange={setEmpty} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// SettingRow
// ---------------------------------------------------------------------------

function SettingRowSection() {
  const [autoStart, setAutoStart] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const [telemetry, setTelemetry] = useState(false);

  return (
    <PlaygroundSection
      title="SettingRow"
      description="Horizontal settings row with label and description on the left, control on the right."
    >
      <ShowcaseLabel>Toggle off (default)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-md">
          <SettingRow
            label="Auto-start agents"
            description="Launch agents automatically on startup."
          >
            <Switch checked={autoStart} onCheckedChange={setAutoStart} />
          </SettingRow>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Toggle on</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-md">
          <SettingRow
            label="Desktop notifications"
            description="Receive alerts when agent tasks complete."
          >
            <Switch checked={notifications} onCheckedChange={setNotifications} />
          </SettingRow>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Multiple rows</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-md space-y-4">
          <SettingRow
            label="Auto-start agents"
            description="Launch agents automatically on startup."
          >
            <Switch checked={autoStart} onCheckedChange={setAutoStart} />
          </SettingRow>
          <SettingRow
            label="Desktop notifications"
            description="Receive alerts when agent tasks complete."
          >
            <Switch checked={notifications} onCheckedChange={setNotifications} />
          </SettingRow>
          <SettingRow
            label="Usage telemetry"
            description="Share anonymous usage data to improve DorkOS."
          >
            <Switch checked={telemetry} onCheckedChange={setTelemetry} />
          </SettingRow>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// PasswordInput
// ---------------------------------------------------------------------------

function PasswordInputSection() {
  const [controlled, setControlled] = useState(false);

  return (
    <PlaygroundSection
      title="PasswordInput"
      description="Password input with eye/eye-off visibility toggle. Supports controlled and uncontrolled modes."
    >
      <ShowcaseLabel>Uncontrolled (hidden by default)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-xs">
          <PasswordInput placeholder="Enter password" />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Uncontrolled (visible by default)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-xs">
          <PasswordInput placeholder="Enter password" visibleByDefault />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Controlled</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-xs">
          <PasswordInput
            placeholder="Enter password"
            showPassword={controlled}
            onShowPasswordChange={setControlled}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Disabled</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-xs">
          <PasswordInput placeholder="Enter password" disabled />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// FieldCard
// ---------------------------------------------------------------------------

function FieldCardSection() {
  const [autoStart, setAutoStart] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const [telemetry, setTelemetry] = useState(false);

  return (
    <PlaygroundSection
      title="FieldCard"
      description="Rounded card container for grouping related form fields with automatic thin separators between items."
    >
      <ShowcaseLabel>Basic with SettingRows</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-md">
          <FieldCard>
            <FieldCardContent>
              <SettingRow
                label="Auto-start agents"
                description="Launch agents automatically on startup."
              >
                <Switch checked={autoStart} onCheckedChange={setAutoStart} />
              </SettingRow>
              <SettingRow
                label="Desktop notifications"
                description="Receive alerts when agent tasks complete."
              >
                <Switch checked={notifications} onCheckedChange={setNotifications} />
              </SettingRow>
              <SettingRow
                label="Usage telemetry"
                description="Share anonymous usage data to improve DorkOS."
              >
                <Switch checked={telemetry} onCheckedChange={setTelemetry} />
              </SettingRow>
            </FieldCardContent>
          </FieldCard>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>With header above</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-md space-y-2">
          <h3 className="text-sm font-semibold">Diagnostics</h3>
          <p className="text-muted-foreground text-xs">
            Toggle data synchronization paths for debugging.
          </p>
          <FieldCard>
            <FieldCardContent>
              <SettingRow
                label="Cross-client sync"
                description="Real-time updates from other clients."
              >
                <Switch checked={notifications} onCheckedChange={setNotifications} />
              </SettingRow>
              <SettingRow
                label="Message polling"
                description="Periodic refresh of message history."
              >
                <Switch checked={telemetry} onCheckedChange={setTelemetry} />
              </SettingRow>
            </FieldCardContent>
          </FieldCard>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Danger variant</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-md">
          <FieldCard className="border-destructive/50">
            <FieldCardContent>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Reset All Data</p>
                  <p className="text-muted-foreground text-xs">Permanently delete all data.</p>
                </div>
                <button className="bg-destructive text-destructive-foreground rounded-md px-3 py-1.5 text-xs">
                  Reset
                </button>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Restart Server</p>
                  <p className="text-muted-foreground text-xs">
                    Active sessions will be interrupted.
                  </p>
                </div>
                <button className="bg-destructive text-destructive-foreground rounded-md px-3 py-1.5 text-xs">
                  Restart
                </button>
              </div>
            </FieldCardContent>
          </FieldCard>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// CollapsibleFieldCard
// ---------------------------------------------------------------------------

function CollapsibleFieldCardSection() {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [withBadge, setWithBadge] = useState(true);
  const [sync, setSync] = useState(true);
  const [polling, setPolling] = useState(false);

  return (
    <PlaygroundSection
      title="CollapsibleFieldCard"
      description="Collapsible section in a card with right-aligned ChevronDown that rotates -90deg when collapsed."
    >
      <ShowcaseLabel>Collapsed</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-md">
          <CollapsibleFieldCard open={collapsed} onOpenChange={setCollapsed} trigger="Chat Filter">
            <div className="px-4 py-3">Content inside</div>
          </CollapsibleFieldCard>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Expanded with fields</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-md">
          <CollapsibleFieldCard open={expanded} onOpenChange={setExpanded} trigger="Diagnostics">
            <div className="px-4 py-3">
              <SettingRow
                label="Cross-client sync"
                description="Real-time updates from other clients."
              >
                <Switch checked={sync} onCheckedChange={setSync} />
              </SettingRow>
            </div>
            <div className="px-4 py-3">
              <SettingRow
                label="Message polling"
                description="Periodic refresh of message history."
              >
                <Switch checked={polling} onCheckedChange={setPolling} />
              </SettingRow>
            </div>
          </CollapsibleFieldCard>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>With badge</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-md">
          <CollapsibleFieldCard
            open={withBadge}
            onOpenChange={setWithBadge}
            trigger="Advanced"
            badge={
              <Badge variant="secondary" className="text-xs">
                Modified
              </Badge>
            }
          >
            <div className="px-4 py-3">
              <p className="text-muted-foreground text-sm">Advanced settings content here.</p>
            </div>
          </CollapsibleFieldCard>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
