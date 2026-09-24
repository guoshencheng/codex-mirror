import { mkdir, copyFile, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const stage=await mkdtemp(join(tmpdir(),'collector-package-'));
try {
 await mkdir('public/collector',{recursive:true});
 for(const name of ['cli.js','setup.js']) await copyFile('dist/collector/'+name,join(stage,name));
 await writeFile(join(stage,'package.json'),JSON.stringify({name:'codex-status-collector',version:'0.1.0',private:true,type:'module',engines:{node:'>=24'},dependencies:{'better-sqlite3':'13.0.3'},allowScripts:{'better-sqlite3':true}},null,2));
 execFileSync('tar',['-czf',process.cwd()+'/public/collector/collector.tar.gz','-C',stage,'cli.js','setup.js','package.json']);
 const hash=createHash('sha256').update(await readFile('public/collector/collector.tar.gz')).digest('hex');
 await writeFile('public/collector/collector.sha256',hash+'\n');
 console.log('Collector package built: '+hash.slice(0,12));
} finally {await rm(stage,{recursive:true,force:true});}
