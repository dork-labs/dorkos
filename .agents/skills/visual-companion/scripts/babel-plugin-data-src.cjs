// Babel plugin: stamp every host JSX element with where it was written,
// data-src="<file>:<line>:<col>" (col is 1-based), for React prototypes. The
// review layer reads el.closest('[data-src]'), so a pinned note points the
// agent at the exact line. Same idea as code-inspector, LocatorJS and
// lovable-tagger, cut down to one attribute.
//
// Host elements only (<div>, <button>, <svg>…: a lowercase JSXIdentifier).
// Components and member expressions (<Card>, <motion.div>) render a host
// element somewhere else, and that one carries the stamp. An element that
// already has data-src keeps it. The attribute goes first, so a spread that
// passes its own data-src still wins. node_modules is never touched.
//
// Options: { root } paths are recorded relative to it (default process.cwd()),
//          { include } a RegExp a file path must match to be stamped.
//
// Wire it into Vite, dev only:
//   react({ babel: { plugins: command === 'serve'
//     ? [[require.resolve('<skill>/scripts/babel-plugin-data-src.cjs'), { root: __dirname }]]
//     : [] } })
const path = require('path');

module.exports = function dataSrc({ types: t }, options = {}) {
  const root = options.root || process.cwd();
  return {
    name: 'data-src',
    visitor: {
      JSXOpeningElement(p, state) {
        const file = state.filename || (state.file && state.file.opts.filename);
        if (!file || /[\\/]node_modules[\\/]/.test(file)) return;
        if (options.include && !options.include.test(file)) return;
        const { name, attributes, loc } = p.node;
        if (!loc || name.type !== 'JSXIdentifier' || !/^[a-z]/.test(name.name)) return;
        if (attributes.some((a) => a.type === 'JSXAttribute' && a.name.name === 'data-src')) return;
        const rel = path.relative(root, file).split(path.sep).join('/');
        const value = `${rel}:${loc.start.line}:${loc.start.column + 1}`;
        attributes.unshift(t.jsxAttribute(t.jsxIdentifier('data-src'), t.stringLiteral(value)));
      },
    },
  };
};
