import type { Plugin } from 'vite';
import path from 'path';
import fs from 'fs';

export function fixDirnamePolyfill(): Plugin {
  return {
    name: 'fix-dirname-polyfill',
    writeBundle() {
      const mainPath = path.resolve(__dirname, '../dist/main.js');
      let code = fs.readFileSync(mainPath, 'utf-8');
      let fixes = 0;

      code = code.replace(
        /const __dirname\$1=[^;]*fileURLToPath[^;]*;/g,
        () => { fixes++; return 'const __dirname$1=__dirname;'; },
      );

      const polyfill = 'url.fileURLToPath(typeof document>"u"?require("url").pathToFileURL(__filename).href:_documentCurrentScript&&_documentCurrentScript.tagName.toUpperCase()==="SCRIPT"&&_documentCurrentScript.src||new URL("main.js",document.baseURI).href)';
      while (code.includes(polyfill)) {
        code = code.replace(polyfill, '__filename');
        fixes++;
      }

      if (fixes > 0) {
        fs.writeFileSync(mainPath, code);
        console.log(`  fix-dirname-polyfill: replaced ${fixes} Vite polyfill(s)`);
      }
    },
  };
}
