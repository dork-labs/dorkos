import type { Plugin } from 'vite';
import path from 'path';
import fs from 'fs';

export function patchElectronCompat(): Plugin {
  return {
    name: 'patch-electron-compat',
    writeBundle() {
      const mainPath = path.resolve(__dirname, '../dist/main.js');
      let code = fs.readFileSync(mainPath, 'utf-8');

      const preamble = `
(function(){
  var cp=require("child_process"),origSpawn=cp.spawn;
  cp.spawn=function(cmd,args,opts){
    if(opts&&opts.signal){
      var sig=opts.signal;
      opts=Object.assign({},opts);
      delete opts.signal;
      var proc=origSpawn.call(this,cmd,args,opts);
      if(sig.aborted){proc.kill("SIGTERM");}
      else{sig.addEventListener("abort",function(){if(!proc.killed)proc.kill("SIGTERM");});}
      return proc;
    }
    return origSpawn.call(this,cmd,args,opts);
  };
  var ev=require("events"),origSML=ev.setMaxListeners;
  ev.setMaxListeners=function(){
    try{return origSML.apply(this,arguments);}
    catch(e){if(e&&e.code==="ERR_INVALID_ARG_TYPE")return;throw e;}
  };
})();
`;

      if (code.startsWith('"use strict";')) {
        code = '"use strict";' + preamble + code.slice('"use strict";'.length);
      } else {
        code = preamble + code;
      }

      fs.writeFileSync(mainPath, code);
      console.log('  patch-electron-compat: patched spawn() and setMaxListeners() for Electron');
    },
  };
}
