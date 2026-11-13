/**
 * Classes that let an approval card's action button wrap onto more lines.
 *
 * A tool or server name can be 40 characters with no space, so a one-line
 * button ran past the card on a phone (DOR-4247). `whitespace-normal` alone is
 * not enough: the button's own size classes fix its height (`h-11 md:h-8`) and
 * stop it shrinking, so the height goes `auto` at both breakpoints, keeps the
 * same minimum, and the width is capped at the row's.
 */
export const WRAPPING_ACTION_CLASS =
  'h-auto min-h-11 max-w-full py-1 text-left [overflow-wrap:anywhere] whitespace-normal md:h-auto md:min-h-8';
