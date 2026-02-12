import type { Plugin } from 'vite';

export function safeRequires(): Plugin {
  const optionalPackages = [
    '@emotion/is-prop-valid',
    'ajv-formats/dist/formats',
    'ajv/dist/runtime/equal',
    'ajv/dist/runtime/ucs2length',
    'ajv/dist/runtime/uri',
    'ajv/dist/runtime/validation_error',
  ];
  return {
    name: 'safe-requires',
    renderChunk(code) {
      let result = code;
      for (const pkg of optionalPackages) {
        const escaped = pkg.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
        const pattern = new RegExp(`require\\("${escaped}"\\)`, 'g');
        result = result.replace(
          pattern,
          `(function(){try{return require("${pkg}")}catch(e){return{}}})()`,
        );
      }
      return { code: result, map: null };
    },
  };
}
