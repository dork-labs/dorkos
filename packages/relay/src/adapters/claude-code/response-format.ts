/** Chat formatting context, independent of message dispatch. */
export interface ResponseContext {
  platform?: string;
  maxLength?: number;
  supportedFormats?: string[];
  formattingInstructions?: string;
}

/**
 * Build a `<response_format>` system prompt block from platform response context.
 *
 * The function is a thin wrapper: it adds a platform header and passes through
 * whatever formatting instructions the adapter provided. When no adapter-supplied
 * `formattingInstructions` are present, a generic fallback is used for platforms
 * that don't support Markdown.
 *
 * Returns an empty string when no platform context is available, so the agent
 * behaves identically to today for non-adapter message sources.
 *
 * @param ctx - The inbound adapter’s formatting context.
 */
export function buildResponseFormatBlock(ctx: ResponseContext | undefined): string {
  if (!ctx?.platform) return '';

  const lines = [
    `Platform: ${ctx.platform}`,
    ctx.maxLength ? `Maximum response length: ${ctx.maxLength} characters` : '',
  ];

  if (ctx.formattingInstructions) {
    lines.push('', ctx.formattingInstructions);
  } else if (ctx.supportedFormats && !ctx.supportedFormats.includes('markdown')) {
    lines.push('', 'FORMATTING RULES (you MUST follow these):');
    lines.push(
      '- Avoid complex Markdown formatting (tables, headings) — use plain text with bullet points.'
    );
  }

  return `<response_format>\n${lines.filter(Boolean).join('\n')}\n</response_format>`;
}
