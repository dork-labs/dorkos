/**
 * Escaping for the handful of places `apps/site` builds HTML as a string
 * rather than as JSX.
 *
 * React escapes interpolations for you; a template literal does not. Two
 * surfaces here assemble markup by hand and so have to do it themselves: the
 * standalone `429` page a throttled email link returns
 * (`lib/rate-limit/too-many-requests-page.ts`) and the transactional emails
 * (`lib/mailer.ts`). Both feed in text a stranger controls, so this lives in
 * one place rather than being written twice slightly differently.
 *
 * @module lib/html/escape-html
 */

/**
 * Escape the few characters that could otherwise break out of the markup.
 *
 * **Text content only.** This escapes `&`, `<` and `>`, which is everything
 * that matters between tags, but it leaves quotes intact — so the result is
 * not safe to drop into an unquoted or single-quoted attribute value. Nothing
 * here needs that today: every attribute either carries a value the codebase
 * constructed (a `resolveBaseURL()` origin, a row id) or a module constant.
 * For an attribute value, use {@link escapeHtmlAttribute}.
 *
 * The ampersand is replaced first on purpose: replacing `<` before `&` would
 * turn an already-escaped `&lt;` into `&amp;lt;` on the next pass.
 *
 * @param value - Untrusted text destined for HTML text content.
 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escape a value for a double- or single-quoted HTML attribute.
 *
 * Everything {@link escapeHtml} does, plus both quote characters, so the value
 * cannot close the attribute it sits in. Use it for every interpolated
 * attribute, including values the codebase built itself: the escaping costs
 * nothing, and it keeps the safety of the markup from resting on what a caller
 * promises to pass.
 *
 * @param value - Text destined for a quoted attribute value.
 */
export function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
