/**
 * Types for `button-label.mjs`: the whole label a JSX node renders as a
 * button's text, for the vocab gate's `"match": "button-label"` terms.
 *
 * @module scripts/vocab-gate/button-label
 */
import type ts from 'typescript';

/**
 * The whole label `node` renders as a button's text, or `undefined` when it is
 * not one.
 *
 * @param node - A JSX text node or a string literal.
 */
export declare function buttonLabel(node: ts.Node): string | undefined;
