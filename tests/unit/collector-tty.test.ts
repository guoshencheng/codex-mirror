import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it, expect } from 'vitest';
const hasPython = spawnSync('python3', ['--version']).status === 0;
it.skipIf(!hasPython)('piped setup hides Token, exits without extra input, and does not persist rejected credentials', async () => {
 for(const accepted of [false,true]) {
  const root=await mkdtemp(join(tmpdir(),'collector-tty-'));
  try {
   const preload=join(root,'network.mjs');
   await writeFile(preload,`globalThis.fetch=async(input)=>String(input).endsWith('/api/agent/register')?Response.json(${accepted ? '{deviceId:"test-device",deviceToken:"d".repeat(43)}' : '{error:"UNAUTHORIZED"}'},{status:${accepted ? 201 : 401}}):Response.json({ok:true});`);
   const config=join(root,'config.json');
   const result=spawnSync('python3',['tests/support/collector-tty.py',process.execPath,'--import','tsx','--import',preload,resolve('collector/src/setup.ts'),'--no-service'],{cwd:process.cwd(),encoding:'utf8',timeout:18000,env:{...process.env,TEST_ADMIN_TOKEN:'cdu_'+'z'.repeat(43),COLLECTOR_CONFIG:config,CODEX_HOME:join(root,'codex'),COLLECTOR_SERVER_URL:'https://dashboard.example'}});
   expect(result.stdout).not.toContain('TTY_TIMEOUT');
   expect(result.stdout).not.toContain('TOKEN_ECHOED');
   expect(result.status, result.stdout+result.stderr).toBe(accepted ? 0 : 1);
   if(accepted) {
    expect(JSON.parse(await readFile(config,'utf8')).deviceId).toBe('test-device');
    expect((await stat(config)).mode & 0o777).toBe(0o600);
   } else {
    await expect(stat(config)).rejects.toThrow();
    await expect(stat(join(root,'codex/hooks.json'))).rejects.toThrow();
   }
  }finally{await rm(root,{recursive:true,force:true});}
 }
},30000);
