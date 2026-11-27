/**
 * Find the whole label a JSX button renders, for the vocab gate's
 * `"match": "button-label"` waves (DOR-4943).
 *
 * The app-copy rule bans five button labels outright: OK, Yes, No, Submit and
 * Confirm. Banning those as words would fire on every sentence that says "No
 * agents yet", so a button-label wave matches only a node that IS a button's
 * whole label: the text inside `<Button>`, `<button>`, any `*Button`
 * component, or an `AlertDialogAction`/`AlertDialogCancel`. An icon element
 * beside the text does not change the label; a `{value}` or a second piece of
 * text does, because then the word is part of a longer label.
 *
 * What it does not see: a label passed as a prop (`confirmLabel="Confirm"`)
 * and a label built by concatenation. Both are rarer than button children and
 * would need the gate to follow a value to where it renders.
 */
import ts from 'typescript';

/** A tag that renders a button: `button`, `Button`, `*Button`, or an alert dialog's two actions. */
const BUTTON_TAG = /^button$|Button$|^AlertDialog(Action|Cancel)$/;

/** Whether a JSX element's tag renders a button, judged by the last segment of its name. */
/**
 * @param {import('typescript').Node} node
 * @returns {node is import('typescript').JsxElement}
 */
function isButtonElement(node) {
  if (!ts.isJsxElement(node)) return false;
  const name = node.openingElement.tagName.getText();
  return BUTTON_TAG.test(name.slice(name.lastIndexOf('.') + 1));
}

/** Whether a button child adds nothing to the label: blank text, an empty `{}`, or an element such as an icon. */
/**
 * @param {import('typescript').JsxChild} child
 * @returns {boolean}
 */
function addsNoText(child) {
  if (ts.isJsxText(child)) return child.text.trim().length === 0;
  if (ts.isJsxExpression(child)) return child.expression === undefined;
  return ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child);
}

/**
 * The whole label `node` renders as a button's text, or `undefined` when it is
 * not one.
 *
 * - JSX text counts when its parent is a button and every other child adds no
 *   text (see {@link addsNoText}).
 * - A string literal counts when it reaches a button's `{...}` child through
 *   parentheses, a ternary or `??`/`||`/`&&`, and that `{...}` is the only
 *   child that adds text: `{busy ? 'Saving…' : 'OK'}` is a label of OK.
 *
 * @param {import('typescript').Node} node - A JSX text node or a string literal.
 * @returns {string | undefined}
 */
export function buttonLabel(node) {
  if (ts.isJsxText(node)) {
    const parent = node.parent;
    if (!isButtonElement(parent)) return undefined;
    const others = parent.children.filter((child) => child !== node);
    return others.every(addsNoText) ? node.text.trim() : undefined;
  }
  if (!ts.isStringLiteralLike(node)) return undefined;

  /** @type {import('typescript').Node} */
  let current = node;
  for (let hop = 0; hop < 8; hop++) {
    const parent = current.parent;
    if (!parent) return undefined;
    if (ts.isJsxExpression(parent)) {
      const element = parent.parent;
      if (!isButtonElement(element)) return undefined;
      const others = element.children.filter((child) => child !== parent);
      return others.every(addsNoText) ? node.text.trim() : undefined;
    }
    const transparent =
      ts.isParenthesizedExpression(parent) ||
      (ts.isConditionalExpression(parent) && parent.condition !== current) ||
      (ts.isBinaryExpression(parent) &&
        ['??', '||', '&&'].includes(parent.operatorToken.getText()));
    if (!transparent) return undefined;
    current = parent;
  }
  return undefined;
}
