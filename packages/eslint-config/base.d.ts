import type { ESLint, Linter } from 'eslint';

declare const baseConfig: Linter.Config[];
export default baseConfig;

/** The repo's own rules, including `restricted-syntax` (see `base.js`). */
export declare const dorkosPlugin: ESLint.Plugin;
