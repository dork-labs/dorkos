/**
 * Telegram adapter compliance — the capability-driven sections of the shared
 * suite that pin the high-severity Telegram bug classes (echo loops, the
 * split-after-format 4096 failure, approval cards hard-failing on unescaped
 * tool input) against the adapter's real code.
 *
 * The Telegram adapter is not headless-startable — `start()` opens a live bot
 * connection — so `startable: false` skips the lifecycle/delivery contract
 * checks (they run for webhook/test-mode) and only the no-start capability
 * checks execute here.
 */
import { describe, it, expect } from 'vitest';
import { TelegramAdapter } from '../index.js';
import { TelegramThreadIdCodec } from '../../../lib/thread-id.js';
import {
  splitTelegramHtml,
  escapeHtml,
  formatToolDescriptionHtml,
  truncateText,
  TELEGRAM_HARD_LIMIT,
} from '../../../lib/payload-utils.js';
import { runAdapterComplianceSuite } from '../../../testing/index.js';

const ADAPTER_ID = 'tg-compliance';
const CODEC = new TelegramThreadIdCodec(ADAPTER_ID);

/** Telegram's supported HTML tag set for `parse_mode: 'HTML'`. */
const TELEGRAM_TAGS = ['b', 'i', 's', 'u', 'code', 'pre', 'a', 'tg-spoiler', 'blockquote'];

/**
 * Verify Telegram HTML has balanced, properly-nested tags and no stray angle
 * brackets — i.e. it is the well-formed markup Telegram's parser accepts rather
 * than the unbalanced fragments that trigger a 400 and fail the whole delivery.
 *
 * @param html - A single converted chunk to validate
 */
function isBalancedTelegramHtml(html: string): boolean {
  const stack: string[] = [];
  const tagRe = /<(\/?)([a-zA-Z-]+)(?:\s[^>]*)?>/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = tagRe.exec(html)) !== null) {
    // Every character between tags must not contain a raw '<' or '>' — those
    // must have been HTML-escaped to &lt;/&gt; by the converter.
    const between = html.slice(consumed, match.index);
    if (between.includes('<') || between.includes('>')) return false;
    consumed = tagRe.lastIndex;

    const [, closing, rawName] = match;
    const name = rawName.toLowerCase();
    if (!TELEGRAM_TAGS.includes(name)) return false;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  const tail = html.slice(consumed);
  if (tail.includes('<') || tail.includes('>')) return false;
  return stack.length === 0;
}

/** Strip Telegram HTML tags and unescape entities back to plain text. */
function telegramToPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** A markup-rich, over-limit sample that forces real markdown→HTML conversion + splitting. */
function buildRichSample(): string {
  let out = '';
  let i = 0;
  while (out.length < TELEGRAM_HARD_LIMIT * 3) {
    out += `Paragraph ${i} with **bold text** and \`inline code\` and a & < > entity.\n\n`;
    out += '```ts\nconst x: number = ' + i + ';\nconsole.log(x < 10 && x > 0);\n```\n\n';
    i += 1;
  }
  return out;
}

/** Mirror of the Telegram approval-card body, built from the same real escapers the card uses. */
function renderApprovalCard(toolName: string, input: string): string {
  return (
    `<b>Tool Approval Required</b>\n` +
    `<code>${escapeHtml(toolName)}</code> ${formatToolDescriptionHtml(toolName, input)}\n\n` +
    `<pre>${escapeHtml(truncateText(input, 400))}</pre>`
  );
}

describe('Telegram — capability compliance', () => {
  runAdapterComplianceSuite({
    name: 'TelegramAdapter',
    createAdapter: () =>
      new TelegramAdapter(ADAPTER_ID, {
        token: '123456789:FAKEfakeFAKEfakeFAKEfakeFAKEfakeFA1',
        mode: 'polling',
        streaming: true,
      }),
    deliverSubject: `${CODEC.prefix}.424242`,
    codec: CODEC,
    samplePlatformId: '424242',
    capabilities: {
      // start() opens a real grammy bot connection — skip the startable contract checks.
      startable: false,
      echoPrevention: {
        selfFrom: `${CODEC.prefix}.bot`,
        externalFrom: 'agent:external-sender',
      },
      messageSplitting: {
        limit: TELEGRAM_HARD_LIMIT,
        split: (text) => splitTelegramHtml(text),
        isValidChunk: isBalancedTelegramHtml,
        toPlainText: telegramToPlainText,
        sampleMarkup: buildRichSample(),
      },
      approvalInputSafety: {
        render: renderApprovalCard,
        isValid: isBalancedTelegramHtml,
      },
    },
  });

  it('balanced-HTML predicate rejects unbalanced markup (guard self-check)', () => {
    expect(isBalancedTelegramHtml('<b>ok</b>')).toBe(true);
    expect(isBalancedTelegramHtml('<b>oops')).toBe(false);
    expect(isBalancedTelegramHtml('a < b')).toBe(false);
    expect(isBalancedTelegramHtml('<pre><b>x</pre></b>')).toBe(false);
  });
});
