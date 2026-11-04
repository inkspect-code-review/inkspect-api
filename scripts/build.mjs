import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const result=await build({entryPoints:{"server":"src/self-hosted/server.ts","engine-worker":"src/self-hosted/engine-worker.ts","pull-request-worker":"src/self-hosted/pull-request-worker.ts","metadata-worker":"src/metadata-worker.ts","engine-admin":"src/self-hosted/engine-admin.ts"},outdir:'dist',outExtension:{'.js':'.mjs'},bundle:true,platform:'node',target:'node22',format:'esm',external:Object.keys(pkg.dependencies).filter(n=>!n.startsWith('@inkspect/')),sourcemap:true,metafile:true});
for(const p of Object.keys(result.metafile.inputs))if(p.includes('/cloud/')||p.includes('@inkspect/cloud-')||p.includes('@polar-sh/'))throw new Error('Private module in API bundle: '+p);
await writeFile('dist/build-inputs.json',JSON.stringify(result.metafile.inputs,null,2));
