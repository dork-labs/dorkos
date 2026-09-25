/**
 * What a template brings into the new agent's folder, shown before the agent
 * is created from it (DOR-2325).
 *
 * The server answers a template that brings settings or programs with
 * `template_needs_review` instead of creating the agent. A person's own
 * template is theirs to use, so this shows them everything it brings and lets
 * them create the agent knowingly: the retry carries the content hash they
 * were shown, and a template that changed since is shown again.
 *
 * @module features/agent-creation/ui/TemplateReviewNotice
 */
import { ShieldAlert } from 'lucide-react';
import type { DisclosedEffects } from '@dorkos/shared/marketplace-schemas';
import { Button } from '@/layers/shared/ui';

/** What the server says a template brings. */
export interface TemplateBrings {
  /** Where it comes from. */
  source: string;
  /** Its content hash, sent back to create it knowingly. */
  contentHash: string;
  /** Settings files the new agent's sessions load. */
  findings: { path: string; message: string }[];
  /**
   * Each file under `findings`, its text with hidden and control characters
   * already shown as `<U+XXXX>`, or why it is not shown.
   */
  settings?: TemplateSettingsFile[];
  /** What its skills run and may do without asking. */
  disclosed: DisclosedEffects;
}

/**
 * The template's contents from a create error, when the server asked for a
 * review.
 *
 * @param error - The create mutation's error.
 */
export function templateReviewOf(error: unknown): TemplateBrings | undefined {
  const body = (error as { body?: { code?: string; template?: TemplateBrings } } | null)?.body;
  return body?.code === 'template_needs_review' ? body.template : undefined;
}

/** One settings file a template carries, as the server wrote it out. */
export interface TemplateSettingsFile {
  /** Its path in the template. */
  path: string;
  /** Its size. */
  bytes: number;
  /** Its text, with hidden characters made visible; absent when not shown. */
  content?: string;
  /** Why it is not shown. */
  omitted?: 'too-long' | 'not-text' | 'link';
}

/** One line of the review, with the settings files behind it when it is one. */
interface ReviewLine {
  key: string;
  label: string;
  detail: string;
  files?: TemplateSettingsFile[];
}

/** The files a finding covers: the file itself, or everything in its folder. */
function filesOf(finding: string, settings: readonly TemplateSettingsFile[]) {
  const folder = finding.replace(/\/*$/, '/');
  return settings.filter((f) => f.path === finding || f.path.startsWith(folder));
}

/** Why a settings file is not written out, in plain words. */
function omittedText(file: TemplateSettingsFile): string {
  if (file.omitted === 'link') return 'A link, which is not copied into the new agent.';
  if (file.omitted === 'not-text') return `Not text (${file.bytes} bytes).`;
  return `Too long to show here (${file.bytes} bytes). Read it in the template before you create the agent.`;
}

/** One line per thing the template runs or allows, in plain words. */
function linesOf(template: TemplateBrings): ReviewLine[] {
  const { disclosed } = template;
  return [
    ...template.findings.map((f) => ({
      key: `finding:${f.path}`,
      label: f.path,
      detail: 'Settings the new agent’s sessions load (hooks, permission rules or servers).',
      files: filesOf(f.path, template.settings ?? []),
    })),
    ...disclosed.hooks.map((h, i) => ({
      key: `hook:${i}`,
      label: h.command,
      detail: `Runs on ${h.event}${h.source ? `, while ${h.source} is in use` : ''}.`,
    })),
    ...disclosed.mcpServers.map((s) => ({
      key: `mcp:${s.name}`,
      label: s.command ? [s.command, ...s.args].join(' ') : (s.url ?? s.name),
      detail: `Starts the MCP server "${s.name}".`,
    })),
    ...disclosed.skillTools.map((t) => ({
      key: `tools:${t.source}`,
      label: t.tools.join(', '),
      detail: `Skill "${t.skill}" may use these without asking you.`,
    })),
  ];
}

/** Props for {@link TemplateReviewNotice}. */
export interface TemplateReviewNoticeProps {
  /** What the template brings. */
  template: TemplateBrings;
  /** Create the agent with exactly this template. */
  onCreateAnyway: () => void;
  /** Go back without creating anything. */
  onCancel: () => void;
  /** True while the retry is in flight. */
  isCreating: boolean;
}

/**
 * The review: every settings file and program the template brings, and a
 * choice to create the agent with them or not.
 */
export function TemplateReviewNotice({
  template,
  onCreateAnyway,
  onCancel,
  isCreating,
}: TemplateReviewNoticeProps) {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
      data-testid="template-review"
    >
      <p className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
        <ShieldAlert className="size-4 shrink-0" aria-hidden />
        This template brings things that run in the new agent’s sessions
      </p>
      <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
        From {template.source}. Check each one before you create the agent.
      </p>
      <ul className="space-y-2">
        {linesOf(template).map((line) => (
          <li key={line.key} className="text-xs">
            <code className="bg-muted text-foreground block rounded px-1.5 py-1 font-mono [overflow-wrap:anywhere]">
              {line.label}
            </code>
            <span className="text-muted-foreground">{line.detail}</span>
            {line.files?.map((file) => (
              <details key={file.path} className="mt-1" data-testid="template-settings-file">
                <summary className="text-muted-foreground hover:text-foreground cursor-pointer">
                  {file.path === line.label ? 'Show what it contains' : `Show ${file.path}`}
                </summary>
                {file.content !== undefined ? (
                  <pre className="border-border/60 bg-muted/40 mt-1 max-h-56 overflow-auto rounded border p-2 font-mono text-xs break-words whitespace-pre-wrap">
                    {file.content}
                  </pre>
                ) : (
                  <p className="text-muted-foreground mt-1">{omittedText(file)}</p>
                )}
              </details>
            ))}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isCreating}>
          Don’t create it
        </Button>
        <Button size="sm" onClick={onCreateAnyway} disabled={isCreating}>
          {isCreating ? 'Creating…' : 'Create with these'}
        </Button>
      </div>
    </div>
  );
}
