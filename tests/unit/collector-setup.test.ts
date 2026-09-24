import { mkdtemp, readFile, stat, writeFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { activateLaunchAgent, adoptExistingDevice, configureCollector, findCodexCommand, inspectExistingInstall, loadRegistrationKey, prepareExistingInstall, probeMigrationTarget, resolveRegistrationCredential, serviceDefinition, verifyFirstHeartbeat, writeServiceWithRollback } from '../../collector/src/setup';
import { openQueue } from '../../collector/src/queue';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, {recursive:true,force:true}))); });
it('uses the one-time install grant without requesting a Dashboard Token', async () => {
  const prompt = vi.fn(async () => 'dashboard-user-token');
  await expect(resolveRegistrationCredential('g'.repeat(43), prompt)).resolves.toEqual({ enrollmentGrant: 'g'.repeat(43) });
  expect(prompt).not.toHaveBeenCalled();
});
it('keeps hidden Dashboard Token registration available for the generic installer', async () => {
  await expect(resolveRegistrationCredential(undefined, async () => ' dashboard-user-token ')).resolves.toEqual({ userToken: 'dashboard-user-token' });
});
it('creates the private config directory before writing a first-install registration key', async () => {
  const root=await mkdtemp(join(tmpdir(),'collector-setup-')); dirs.push(root);
  const keyPath=join(root,'new-config-dir','config.json.registration-id');
  const key=await loadRegistrationKey(keyPath);
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await readFile(keyPath,'utf8')).toBe(`${key}\n`);
  expect((await stat(join(root,'new-config-dir'))).mode & 0o777).toBe(0o700);
  expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
});
it('writes private config, preserves unrelated hooks, and is idempotent without losing the device queue', async () => {
  const root=await mkdtemp(join(tmpdir(),'collector-setup-')); dirs.push(root);
  const paths={ configPath:join(root,'config.json'), hooksPath:join(root,'hooks.json'), cliPath:'/opt/collector/cli.js', nodePath:process.execPath };
  await writeFile(paths.hooksPath, JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'echo existing'}]}]}}));
  const input={schemaVersion:1 as const,deviceId:'device-one',deviceToken:'a'.repeat(43),serverUrl:'https://dashboard.example',queuePath:'./events.sqlite'};
  await configureCollector(paths,input);
  await writeFile(join(root,'events.sqlite'),'existing queue');
  await configureCollector(paths,input);
  expect((await stat(paths.configPath)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(paths.configPath,'utf8')).deviceId).toBe('device-one');
  const hooks=JSON.parse(await readFile(paths.hooksPath,'utf8'));
  expect(hooks.hooks.Stop).toHaveLength(2);
  expect(hooks.hooks.Stop[0].hooks[0].command).toBe('echo existing');
  expect(await readFile(join(root,'events.sqlite'),'utf8')).toBe('existing queue');
  await expect(configureCollector(paths,{...input,deviceId:'different-device'})).rejects.toThrow('EXISTING_DEVICE_CONFIG');
  await expect(configureCollector(paths,{...input,deviceId:'different-device',serverUrl:'https://new.example'},{allowServerMigration:true})).rejects.toThrow('EXISTING_DEVICE_CONFIG');
});
it('detects an installed collector and migrates only its server URL while preserving device identity and queue', async () => {
 const root=await mkdtemp(join(tmpdir(),'collector-setup-')); dirs.push(root);
 const paths={configPath:join(root,'config.json'),hooksPath:join(root,'hooks.json'),cliPath:join(root,'cli.js'),nodePath:process.execPath};
 const original={schemaVersion:1 as const,deviceId:'device-one',deviceToken:'a'.repeat(43),serverUrl:'https://old.example',queuePath:'./events.sqlite'};
 await writeFile(paths.cliPath,'collector script');
 await configureCollector(paths,original);
 await writeFile(join(root,'events.sqlite'),'existing queue');
 const installed=await inspectExistingInstall(paths);
 expect(installed).toMatchObject({hasConfig:true,hasManagedHooks:true,hasCollectorScript:true});
 await expect(probeMigrationTarget('https://new.example',original.deviceToken,original.deviceId,async () => Response.json({deviceId:'device-one'}))).resolves.toBeUndefined();
 await configureCollector(paths,{...original,serverUrl:'https://new.example'},{allowServerMigration:true});
 expect(JSON.parse(await readFile(paths.configPath,'utf8'))).toMatchObject({deviceId:'device-one',deviceToken:original.deviceToken,serverUrl:'https://new.example',queuePath:'./events.sqlite'});
 expect(await readFile(join(root,'events.sqlite'),'utf8')).toBe('existing queue');
});
it('does not accept an unrecognized or mismatched device on the target server', async () => {
 await expect(probeMigrationTarget('https://new.example','a'.repeat(43),'device-one',async () => Response.json({error:'UNAUTHORIZED'},{status:401}))).rejects.toThrow('MIGRATION_REENROLL_REQUIRED');
 await expect(probeMigrationTarget('https://new.example','a'.repeat(43),'device-one',async () => Response.json({deviceId:'different'}))).rejects.toThrow('MIGRATION_DEVICE_MISMATCH');
 await expect(probeMigrationTarget('https://new.example','a'.repeat(43),'device-one',async () => Response.json({error:'SERVICE_UNAVAILABLE'},{status:503}))).rejects.toThrow('MIGRATION_TARGET_UNAVAILABLE');
});
it('uses a scoped grant to adopt the old identity without changing local device credentials', async () => {
 const config={schemaVersion:1 as const,deviceId:'device-one',deviceToken:'a'.repeat(43),serverUrl:'https://old.example',queuePath:'./events.sqlite'};
 const fetcher=vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  expect(String(url)).toBe('https://new.example/api/agent/register');
  expect(JSON.parse(String(init?.body))).toMatchObject({
   enrollmentGrant:'g'.repeat(43), existingDeviceId:'device-one', existingDeviceToken:config.deviceToken,
  });
  expect(init?.redirect).toBe('error');
  return Response.json({deviceId:'device-one',deviceToken:config.deviceToken},{status:201});
 });
 await adoptExistingDevice('https://new.example','g'.repeat(43),config,fetcher);
 expect(fetcher).toHaveBeenCalledOnce();
 expect(config.serverUrl).toBe('https://old.example');
 await expect(adoptExistingDevice('https://new.example','g'.repeat(43),config,async () => new Response(null,{status:409})))
  .rejects.toThrow('MIGRATION_DEVICE_CONFLICT');
});
it('plans an existing install before changing its config and refuses an unknown target', async () => {
 const root=await mkdtemp(join(tmpdir(),'collector-setup-')); dirs.push(root);
 const paths={configPath:join(root,'config.json'),hooksPath:join(root,'hooks.json'),cliPath:join(root,'cli.js'),nodePath:process.execPath};
 const original={schemaVersion:1 as const,deviceId:'device-one',deviceToken:'a'.repeat(43),serverUrl:'https://old.example',queuePath:'./events.sqlite'};
 await writeFile(paths.cliPath,'collector script');
 await configureCollector(paths,original);
 const before=await readFile(paths.configPath,'utf8');
 await expect(prepareExistingInstall(paths,'https://new.example',async () => Response.json({error:'UNAUTHORIZED'},{status:401}))).rejects.toThrow('MIGRATION_REENROLL_REQUIRED');
 expect(await readFile(paths.configPath,'utf8')).toBe(before);
 const planned=await prepareExistingInstall(paths,'https://new.example',async () => Response.json({deviceId:'device-one'}));
 expect(planned?.migrating).toBe(true);
 expect(planned?.config.serverUrl).toBe('https://new.example');
 expect(await readFile(paths.configPath,'utf8')).toBe(before);
});
it('checks identity for a one-time install even when the server URL has not changed', async () => {
 const root=await mkdtemp(join(tmpdir(),'collector-setup-')); dirs.push(root);
 const paths={configPath:join(root,'config.json'),hooksPath:join(root,'hooks.json'),cliPath:join(root,'cli.js'),nodePath:process.execPath};
 const original={schemaVersion:1 as const,deviceId:'device-one',deviceToken:'a'.repeat(43),serverUrl:'https://dashboard.example',queuePath:'./events.sqlite'};
 await configureCollector(paths,original);
 await expect(prepareExistingInstall(paths,undefined,async () => Response.json({error:'UNAUTHORIZED'},{status:401}),true))
  .rejects.toThrow('MIGRATION_REENROLL_REQUIRED');
 expect(await readFile(paths.configPath,'utf8')).toContain('device-one');
});
it('does not treat an existing symlinked device config as a fresh installation', async () => {
 const root=await mkdtemp(join(tmpdir(),'collector-setup-')); dirs.push(root);
 const paths={configPath:join(root,'config.json'),hooksPath:join(root,'hooks.json'),cliPath:join(root,'cli.js'),nodePath:process.execPath};
 await writeFile(join(root,'other.json'),'{}');
 await symlink(join(root,'other.json'),paths.configPath);
 await expect(prepareExistingInstall(paths,'https://new.example')).rejects.toThrow('CONFIG_FILE_UNAVAILABLE');
});
it('stops a fresh registration when managed Hooks remain without device config', async () => {
 const root=await mkdtemp(join(tmpdir(),'collector-setup-')); dirs.push(root);
 const paths={configPath:join(root,'config.json'),hooksPath:join(root,'hooks.json'),cliPath:join(root,'cli.js'),nodePath:process.execPath,servicePath:join(root,'service')};
 await writeFile(paths.hooksPath,JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:"'/old/cli.js' hook Stop --managed-by=codex-status-dashboard"}]}]}}));
 await expect(prepareExistingInstall(paths,'https://new.example')).rejects.toThrow('PARTIAL_INSTALL_WITHOUT_CONFIG');
});
it('stops a fresh registration when an old event queue remains without device config', async () => {
 const root=await mkdtemp(join(tmpdir(),'collector-setup-')); dirs.push(root);
 const paths={configPath:join(root,'config.json'),hooksPath:join(root,'hooks.json'),cliPath:join(root,'cli.js'),nodePath:process.execPath,servicePath:join(root,'service')};
 await writeFile(join(root,'events.sqlite'),'old queue');
 await expect(prepareExistingInstall(paths,'https://new.example')).rejects.toThrow('PARTIAL_INSTALL_WITHOUT_CONFIG');
});
it('resumes an interrupted registration with the same key and device-bound queue', async () => {
 const root=await mkdtemp(join(tmpdir(),'collector-setup-')); dirs.push(root);
 const paths={configPath:join(root,'config.json'),hooksPath:join(root,'hooks.json'),cliPath:join(root,'cli.js'),nodePath:process.execPath,servicePath:join(root,'service')};
 const key=await loadRegistrationKey(`${paths.configPath}.registration-id`);
 const queue=openQueue(join(root,'events.sqlite'),100_000_000,'registered-device');
 queue.close();
 await expect(prepareExistingInstall(paths,'https://dashboard.example')).resolves.toBeNull();
 expect(await loadRegistrationKey(`${paths.configPath}.registration-id`)).toBe(key);
 expect(() => openQueue(join(root,'events.sqlite'),100_000_000,'different-device')).toThrow('DEVICE_ID_MISMATCH');
});
it('retries a temporary first-heartbeat network failure but stops on authentication failure', async () => {
 const wait=vi.fn(async () => {});
 const send=vi.fn().mockRejectedValueOnce(new Error('COLLECTOR_NETWORK_ERROR')).mockResolvedValue(undefined);
 await verifyFirstHeartbeat(send,wait);
 expect(send).toHaveBeenCalledTimes(2);
 expect(wait).toHaveBeenCalledOnce();
 const unauthorized=vi.fn().mockRejectedValue(new Error('HTTP_401'));
 await expect(verifyFirstHeartbeat(unauthorized,wait)).rejects.toThrow('HTTP_401');
 expect(unauthorized).toHaveBeenCalledOnce();
});
it('completes a first install after the registered device heartbeat failed once', async () => {
 const root=await mkdtemp(join(tmpdir(),'collector-setup-')); dirs.push(root);
 const configPath=join(root,'config.json');
 const preload=join(root,'fetch.mjs');
 await writeFile(preload,`import {readFileSync} from 'node:fs';
globalThis.fetch=async (url, options) => {
 if(String(url).endsWith('/api/agent/register')) {
  const key=readFileSync(process.env.COLLECTOR_CONFIG+'.registration-id','utf8').trim();
  if(JSON.parse(options.body).idempotencyKey!==key) throw Error('REGISTRATION_KEY_CHANGED');
  return Response.json({deviceId:'resume-device',deviceToken:'d'.repeat(43)},{status:201});
 }
 if(String(url).endsWith('/api/agent/heartbeat')) return Response.json({ok:true},{status:process.env.TEST_FAIL_HEARTBEAT==='1'?503:200});
 throw Error('UNEXPECTED_REQUEST');
};`);
 const run=(fail: boolean) => spawnSync(process.execPath,['--import','tsx','--import',preload,resolve('collector/src/setup.ts'),'--no-service'],{
  cwd:process.cwd(),encoding:'utf8',timeout:15000,
  env:{...process.env,COLLECTOR_CONFIG:configPath,CODEX_HOME:join(root,'codex'),COLLECTOR_SERVER_URL:'https://dashboard.example',COLLECTOR_ENROLLMENT_GRANT:'g'.repeat(43),TEST_FAIL_HEARTBEAT:fail?'1':'0'},
 });
 const interrupted=run(true);
 expect(interrupted.status,interrupted.stderr).toBe(1);
 expect(interrupted.stderr).toContain('首次心跳阶段失败（HTTP_503）');
 await expect(stat(configPath)).rejects.toThrow();
 expect((await stat(join(root,'events.sqlite'))).isFile()).toBe(true);
 const retryKey=await readFile(`${configPath}.registration-id`,'utf8');
 const resumed=run(false);
 expect(resumed.status,resumed.stderr).toBe(0);
 expect(JSON.parse(await readFile(configPath,'utf8')).deviceId).toBe('resume-device');
 await expect(stat(`${configPath}.registration-id`)).rejects.toThrow();
 expect(retryKey).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
});
it('rejects insecure server config before modifying hooks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'collector-setup-'));dirs.push(root);
 const paths={configPath:join(root,'config.json'),hooksPath:join(root,'hooks.json'),cliPath:'/cli.js',nodePath:process.execPath};
 await expect(configureCollector(paths,{schemaVersion:1,deviceId:'one',deviceToken:'a'.repeat(43),serverUrl:'http://evil.example',queuePath:'./events.sqlite'})).rejects.toThrow();
 await expect(stat(paths.hooksPath)).rejects.toThrow();
});
it('escapes service paths and keeps credentials out of service definitions',()=>{
 const opts={nodePath:'/opt/Node & tools/node',cliPath:'/opt/a b/cli.js',configPath:'/home/a/config.json',logPath:'/home/a/log'};
 const mac=serviceDefinition('darwin',opts);
 expect(mac).toContain('Node &amp; tools');
 expect(mac).toContain('<string>run</string>');
 const linux=serviceDefinition('linux',opts);
 expect(linux).toContain('"/opt/a b/cli.js"');
 expect(linux).toContain('Restart=on-failure');
});
it('preserves configured proxy settings for the background service', () => {
 const paths={nodePath:'/node',cliPath:'/cli.js',configPath:'/config.json',logPath:'/log'};
 const proxy={HTTPS_PROXY:'http://127.0.0.1:7897',NODE_USE_ENV_PROXY:'1'};
 expect(serviceDefinition('darwin',paths,proxy)).toContain('<key>HTTPS_PROXY</key><string>http://127.0.0.1:7897</string>');
 expect(serviceDefinition('linux',paths,proxy)).toContain('Environment="HTTPS_PROXY=http://127.0.0.1:7897"');
});
it('finds the Codex binary bundled in the macOS ChatGPT app when PATH has none', () => {
 const bundled='/Applications/ChatGPT.app/Contents/Resources/codex';
 expect(findCodexCommand('darwin','/opt/homebrew/bin',undefined,candidate=>candidate===bundled)).toBe(bundled);
});
it('restores the previous service file when activation fails', async () => {
 const root=await mkdtemp(join(tmpdir(),'collector-setup-')); dirs.push(root);
 const path=join(root,'collector.service');
 await writeFile(path,'old service\n',{mode:0o600});
 await expect(writeServiceWithRollback(path,'new service\n',async () => { throw new Error('SERVICE_COMMAND_FAILED'); })).rejects.toThrow('SERVICE_COMMAND_FAILED');
 expect(await readFile(path,'utf8')).toBe('old service\n');
});
it('waits for an old LaunchAgent to disappear before bootstrapping its replacement', async () => {
 const calls: string[] = [];
 let prints = 0;
 const run = (args: string[]) => {
  calls.push(args[0]!);
  if (args[0] === 'print') return { status: ++prints <= 2 ? 0 : 113 };
  return { status: 0 };
 };
 await activateLaunchAgent('/tmp/collector.plist', 501, run, async () => { calls.push('wait'); });
 expect(calls).toEqual(['print','bootout','print','wait','print','bootstrap','kickstart']);
});
it('leaves the old LaunchAgent alone when unload does not complete', async () => {
 const calls: string[] = [];
 const run = (args: string[]) => { calls.push(args[0]!); return { status: 0 }; };
 await expect(activateLaunchAgent('/tmp/collector.plist', 501, run, async () => {}, 2)).rejects.toThrow('SERVICE_UNLOAD_TIMEOUT');
 expect(calls).not.toContain('bootstrap');
});
