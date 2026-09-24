import { accessSync, constants, realpathSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, rm, lstat, readFile, copyFile, chmod } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { openSync } from 'node:fs';
import { ReadStream, WriteStream } from 'node:tty';
import { spawnSync } from 'node:child_process';
import { defaultConfigPath, loadCollectorConfig, type CollectorConfig } from './config';
import { defaultHooksConfigPath, installHooks } from './install';

interface Paths { configPath: string; hooksPath: string; cliPath: string; nodePath: string; servicePath?: string }

async function isRegularFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function inspectExistingInstall(paths: Paths): Promise<{
  hasConfig: boolean; hasManagedHooks: boolean; hasCollectorScript: boolean; hasService: boolean;
}> {
  let hasConfig = false;
  try {
    const info = await lstat(paths.configPath);
    if (!info.isFile()) throw new Error('CONFIG_FILE_UNAVAILABLE');
    hasConfig = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let hasManagedHooks = false;
  let hasCollectorScript = false;
  if (await isRegularFile(paths.hooksPath)) {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(paths.hooksPath, 'utf8')); }
    catch { throw new Error('INVALID_HOOKS_CONFIG'); }
    if (parsed && typeof parsed === 'object' && 'hooks' in parsed && parsed.hooks && typeof parsed.hooks === 'object') {
      for (const groups of Object.values(parsed.hooks)) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
          if (!group || !Array.isArray(group.hooks)) continue;
          for (const hook of group.hooks) {
            const command = hook?.command;
            if (typeof command !== 'string' || !command.includes('--managed-by=codex-status-dashboard')) continue;
            hasManagedHooks = true;
            const script = /'([^']*\/cli\.js)' hook /.exec(command)?.[1];
            if (script && await isRegularFile(script)) hasCollectorScript = true;
          }
        }
      }
    }
  }
  const servicePath = paths.servicePath ?? (process.platform === 'darwin'
    ? resolve(homedir(), 'Library/LaunchAgents/com.codex-status-dashboard.collector.plist')
    : resolve(homedir(), '.config/systemd/user/codex-status-dashboard.service'));
  const hasService = await isRegularFile(servicePath) &&
    (await readFile(servicePath, 'utf8')).includes(process.platform === 'darwin' ? xml(paths.configPath) : paths.configPath);
  return { hasConfig, hasManagedHooks, hasCollectorScript, hasService };
}

export async function probeMigrationTarget(
  serverUrl: string, deviceToken: string, deviceId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  let origin: string;
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    origin = url.origin;
  } catch { throw new Error('INVALID_SERVER_URL'); }
  let response: Response;
  try {
    response = await fetcher(`${origin}/api/agent/identity`, {
      headers: { authorization: `Bearer ${deviceToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(5_000), redirect: 'error', cache: 'no-store',
    });
  } catch { throw new Error('MIGRATION_TARGET_UNAVAILABLE'); }
  if (response.status === 401 || response.status === 403) throw new Error('MIGRATION_REENROLL_REQUIRED');
  if (!response.ok) throw new Error('MIGRATION_TARGET_UNAVAILABLE');
  let body: unknown;
  try {
    if (Number(response.headers.get('content-length')) > 4_096 || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 4_096) throw new Error();
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))) as unknown;
  } catch { throw new Error('MIGRATION_TARGET_UNAVAILABLE'); }
  if (!body || typeof body !== 'object' || typeof (body as { deviceId?: unknown }).deviceId !== 'string') throw new Error('MIGRATION_TARGET_UNAVAILABLE');
  if ((body as { deviceId: string }).deviceId !== deviceId) throw new Error('MIGRATION_DEVICE_MISMATCH');
}

export async function prepareExistingInstall(
  paths: Paths, requestedServerUrl: string | undefined, fetcher: typeof fetch = fetch, verifyIdentity = false,
): Promise<{ config: CollectorConfig; previous: CollectorConfig; migrating: boolean; inspection: Awaited<ReturnType<typeof inspectExistingInstall>> } | null> {
  const inspection = await inspectExistingInstall(paths);
  if (!inspection.hasConfig) {
    const queuePath = resolve(dirname(paths.configPath), 'events.sqlite');
    const queueFiles = [queuePath, `${queuePath}-wal`, `${queuePath}-shm`, `${queuePath}.health.json`];
    const hasQueue = (await Promise.all(queueFiles.map(async path => {
      try { await lstat(path); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    }))).some(Boolean);
    if (hasQueue && !inspection.hasManagedHooks && !inspection.hasService && await isRegularFile(queuePath)) {
      const retryKeyPath = `${paths.configPath}.registration-id`;
      if (await isRegularFile(retryKeyPath)) {
        const retryKey = (await readFile(retryKeyPath, 'utf8')).trim();
        if (!/^[A-Za-z0-9_-]{43}$/.test(retryKey)) throw new Error('INVALID_REGISTRATION_KEY');
        // Registration is idempotent; openQueue verifies the returned device ID against this queue.
        return null;
      }
    }
    if (inspection.hasManagedHooks || inspection.hasService || hasQueue) throw new Error('PARTIAL_INSTALL_WITHOUT_CONFIG');
    return null;
  }
  const loaded = loadCollectorConfig(paths.configPath, true);
  const previous = JSON.parse(await readFile(paths.configPath, 'utf8')) as CollectorConfig;
  let target: string;
  try {
    const url = new URL(requestedServerUrl ?? loaded.serverUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    target = url.origin;
  } catch { throw new Error('INVALID_SERVER_URL'); }
  const migrating = target !== loaded.serverUrl;
  if (migrating || verifyIdentity) await probeMigrationTarget(target, loaded.deviceToken, loaded.deviceId, fetcher);
  return { config: { ...previous, serverUrl: target }, previous, migrating, inspection };
}

export async function adoptExistingDevice(
  serverUrl: string, enrollmentGrant: string, config: CollectorConfig,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(enrollmentGrant)) throw new Error('INVALID_INSTALL_GRANT');
  const url = new URL(serverUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('INVALID_SERVER_URL');
  }
  let response: Response;
  try {
    response = await fetcher(`${url.origin}/api/agent/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ enrollmentGrant, deviceName: hostname().trim().slice(0, 120) || 'Codex device',
        existingDeviceId: config.deviceId, existingDeviceToken: config.deviceToken }),
      signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store',
    });
  } catch { throw new Error('MIGRATION_TARGET_UNAVAILABLE'); }
  if (response.status === 401) throw new Error('INVALID_INSTALL_GRANT');
  if (response.status === 409) throw new Error('MIGRATION_DEVICE_CONFLICT');
  if (response.status === 429) throw new Error('REGISTRATION_RATE_LIMITED');
  if (response.status !== 201) throw new Error('DEVICE_REGISTRATION_FAILED');
  // The target's identity endpoint is checked again before local state changes.
}

export type RegistrationCredential = { userToken: string } | { enrollmentGrant: string };

export async function resolveRegistrationCredential(
  enrollmentGrant: string | undefined,
  promptForUserToken: () => Promise<string>,
): Promise<RegistrationCredential> {
  const grant = enrollmentGrant?.trim();
  if (grant) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(grant)) throw new Error('INVALID_INSTALL_GRANT');
    return { enrollmentGrant: grant };
  }
  const userToken = (await promptForUserToken()).trim();
  if (!userToken) throw new Error('INVALID_USER_TOKEN');
  return { userToken };
}

async function registerDevice(serverUrl: string, credential: RegistrationCredential, deviceName: string, idempotencyKey: string): Promise<{ deviceId: string; deviceToken: string }> {
  let origin: string;
  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('INVALID_SERVER_URL');
    }
    origin = parsed.origin;
  } catch {
    throw new Error('INVALID_SERVER_URL');
  }
  const response = await fetch(`${origin}/api/agent/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ...credential, deviceName, idempotencyKey }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
    cache: 'no-store',
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('DEVICE_REGISTRATION_FAILED');
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > 4_096) {
        await reader.cancel();
        throw new Error('DEVICE_REGISTRATION_FAILED');
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (response.status !== 201) {
    if (response.status === 401) throw new Error('INVALID_USER_TOKEN');
    if (response.status === 429) throw new Error('REGISTRATION_RATE_LIMITED');
    throw new Error('DEVICE_REGISTRATION_FAILED');
  }
  let result: unknown;
  try { result = JSON.parse(text) as unknown; } catch { throw new Error('DEVICE_REGISTRATION_FAILED'); }
  if (!result || typeof result !== 'object' ||
      typeof (result as Record<string, unknown>).deviceId !== 'string' ||
      typeof (result as Record<string, unknown>).deviceToken !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test((result as Record<string, string>).deviceId) ||
      !/^[A-Za-z0-9_-]{32,256}$/.test((result as Record<string, string>).deviceToken)) {
    throw new Error('DEVICE_REGISTRATION_FAILED');
  }
  return result as { deviceId: string; deviceToken: string };
}

export async function loadRegistrationKey(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(existing)) throw new Error('INVALID_REGISTRATION_KEY');
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const key = randomBytes(32).toString('base64url');
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${key}\n`, { mode: 0o600, flag: 'wx' });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return loadRegistrationKey(path);
  }
}

export async function configureCollector(paths: Paths, input: CollectorConfig, options: { allowServerMigration?: boolean } = {}): Promise<void> {
  await mkdir(dirname(paths.configPath), { recursive: true, mode: 0o700 });
  const temporary = `${paths.configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(input, null, 2)+'\n', { mode: 0o600, flag: 'wx' });
    loadCollectorConfig(temporary, true);
    let exists = false;
    try { await lstat(paths.configPath); exists = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    let backupPath: string | null = null;
    if (exists) {
      const old = loadCollectorConfig(paths.configPath, true);
      const next = loadCollectorConfig(temporary, true);
      if (JSON.stringify(old) !== JSON.stringify(next)) {
        const { serverUrl: _oldServer, ...oldIdentity } = old;
        const { serverUrl: _newServer, ...newIdentity } = next;
        if (!options.allowServerMigration || JSON.stringify(oldIdentity) !== JSON.stringify(newIdentity)) throw new Error('EXISTING_DEVICE_CONFIG');
        await installHooks(paths.hooksPath, { nodePath: paths.nodePath, cliPath: paths.cliPath, configPath: paths.configPath, dryRun: true });
        backupPath = `${paths.configPath}.${new Date().toISOString().replaceAll(':', '-')}.${randomUUID()}.bak`;
        await copyFile(paths.configPath, backupPath);
        await chmod(backupPath, 0o600);
        await rename(temporary, paths.configPath);
      }
    } else {
      await rename(temporary, paths.configPath);
    }
    try { await installHooks(paths.hooksPath, { nodePath: paths.nodePath, cliPath: paths.cliPath, configPath: paths.configPath }); }
    catch (error) {
      if (backupPath) {
        await copyFile(backupPath, temporary);
        await rename(temporary, paths.configPath);
      }
      throw error;
    }
  } finally { await rm(temporary, {force:true}); }
}
interface ServicePaths { nodePath: string; cliPath: string; configPath: string; logPath: string }
const xml = (s: string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const unitQuote = (s: string) => '"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('$','$$')+'"';
export function serviceDefinition(platform: string, p: ServicePaths, proxyEnvironment: Record<string, string> = {}): string {
  const environment = { COLLECTOR_CONFIG: p.configPath, ...proxyEnvironment };
  if (Object.entries(environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n\0]/.test(value))) throw new Error('INVALID_SERVICE_ENVIRONMENT');
  if (Object.values(p).some(v => /[\r\n\0]/.test(v))) throw new Error('INVALID_SERVICE_PATH');
  if (platform === 'darwin') return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.codex-status-dashboard.collector</string>
<key>ProgramArguments</key><array><string>${xml(p.nodePath)}</string><string>${xml(p.cliPath)}</string><string>run</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key,value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(p.logPath)}</string><key>StandardErrorPath</key><string>${xml(p.logPath)}</string>
</dict></plist>\n`;
  if (platform !== 'linux') throw new Error('UNSUPPORTED_PLATFORM');
  return `[Unit]\nDescription=Codex Status Dashboard collector\nAfter=network-online.target\n\n[Service]\nExecStart=${unitQuote(p.nodePath)} ${unitQuote(p.cliPath)} run\n${Object.entries(environment).map(([key,value]) => 'Environment='+unitQuote(key+'='+value).replaceAll('$$','$')).join('\n')}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}
function execute(command: string, args: string[]): void {
 const result=spawnSync(command,args,{stdio:'inherit'});
 if(result.error || result.status !== 0) throw new Error('SERVICE_COMMAND_FAILED');
}
type LaunchctlRunner = (args: string[], stdio?: 'ignore' | 'inherit') => { status: number | null; error?: Error };
export async function activateLaunchAgent(
 target: string,
 uid: number,
 run: LaunchctlRunner = (args, stdio = 'ignore') => spawnSync('launchctl', args, { stdio }),
 pause: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
 maxChecks = 50,
): Promise<void> {
 const domain = `gui/${uid}`;
 const service = `${domain}/com.codex-status-dashboard.collector`;
 const loaded = run(['print', service], 'ignore');
 if (loaded.error) throw new Error('SERVICE_COMMAND_FAILED');
 if (loaded.status === 0) {
  const stopped = run(['bootout', service], 'ignore');
  if (stopped.error || stopped.status !== 0) throw new Error('SERVICE_COMMAND_FAILED');
  let removed = false;
  for (let check = 0; check < maxChecks; check++) {
   const state = run(['print', service], 'ignore');
   if (state.error) throw new Error('SERVICE_COMMAND_FAILED');
   if (state.status !== 0) { removed = true; break; }
   if (check + 1 < maxChecks) await pause(100);
  }
  if (!removed) throw new Error('SERVICE_UNLOAD_TIMEOUT');
 }
 const started = run(['bootstrap', domain, target], 'inherit');
 if (started.error || started.status !== 0) throw new Error('SERVICE_COMMAND_FAILED');
 const kicked = run(['kickstart', service], 'inherit');
 if (kicked.error || kicked.status !== 0) throw new Error('SERVICE_COMMAND_FAILED');
}
export async function writeServiceWithRollback(target: string, definition: string, activate: () => Promise<void> | void): Promise<void> {
 await mkdir(dirname(target),{recursive:true,mode:0o700});
 let original: Buffer | null = null;
 let originalMode = 0o600;
 try {
  const info = await lstat(target);
  if(info.isSymbolicLink() || !info.isFile()) throw new Error('SERVICE_FILE_UNAVAILABLE');
  original = await readFile(target);
  originalMode = info.mode & 0o777;
 } catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
 const save = async (contents: string | Buffer, mode: number) => {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
   await writeFile(temporary,contents,{mode,flag:'wx'});
   await chmod(temporary,mode);
   await rename(temporary,target);
  } finally { await rm(temporary,{force:true}); }
 };
 await save(definition,0o600);
 try { await activate(); }
 catch(error) {
  if(original) await save(original,originalMode);
  else await rm(target,{force:true});
  if(original) {
   try { await activate(); } catch { /* restoration remains available for manual restart */ }
  }
  throw error;
 }
}
export function findCodexCommand(
 platform: string,
 path: string | undefined,
 requested?: string,
 isExecutable: (candidate: string) => boolean = candidate => {
  try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
 },
): string | undefined {
 const candidates = requested
  ? [requested]
  : [
    ...(path ?? '').split(delimiter).filter(Boolean).map(part => join(part, 'codex')),
    ...(platform === 'darwin' ? ['/Applications/ChatGPT.app/Contents/Resources/codex'] : []),
   ];
 return candidates.find(candidate => isAbsolute(candidate) && isExecutable(candidate));
}

async function installService(paths: Paths): Promise<void> {
 const logPath=resolve(dirname(paths.configPath),'collector.log');
 const target=process.platform==='darwin' ? resolve(homedir(),'Library/LaunchAgents/com.codex-status-dashboard.collector.plist') : resolve(homedir(),'.config/systemd/user/codex-status-dashboard.service');
 const proxyEnvironment: Record<string,string> = { CODEX_HOME: process.env.CODEX_HOME || resolve(homedir(), '.codex') };
 const codexCommand = findCodexCommand(process.platform, process.env.PATH, process.env.CODEX_COMMAND);
 if (codexCommand) proxyEnvironment.CODEX_COMMAND = codexCommand;
 for (const key of ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy']) {
  if(process.env[key]) proxyEnvironment[key]=process.env[key]!;
 }
 if(Object.keys(proxyEnvironment).some(key=>/https?_proxy/i.test(key))) proxyEnvironment.NODE_USE_ENV_PROXY='1';
 const definition=serviceDefinition(process.platform,{...paths,logPath},proxyEnvironment);
 await writeServiceWithRollback(target,definition,async () => {
  if(process.platform==='darwin') {
   await activateLaunchAgent(target, process.getuid!());
  } else {
   execute('systemctl',['--user','daemon-reload']);
   execute('systemctl',['--user','enable','codex-status-dashboard.service']);
   execute('systemctl',['--user','restart','codex-status-dashboard.service']);
  }
 });
}
let setupPhase = '检查已有安装';
export async function verifyFirstHeartbeat(
 send: () => Promise<void>,
 pause: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
): Promise<void> {
 for (let attempt = 0; attempt < 3; attempt++) {
  try { await send(); return; }
  catch (error) {
   const code = error instanceof Error ? error.message : '';
   const transient = code === 'COLLECTOR_NETWORK_ERROR' || /^HTTP_5[0-9]{2}$/.test(code);
   if (!transient || attempt === 2) throw error;
   await pause((attempt + 1) * 1_000);
  }
 }
}
function safeSetupErrorCode(error: unknown): string {
 const message = error instanceof Error ? error.message : '';
 if (/^HTTP_[1-5][0-9]{2}$/.test(message)) return message;
 const known = new Set([
  'COLLECTOR_NETWORK_ERROR', 'INVALID_HEARTBEAT_RESPONSE', 'INVALID_UPLOAD_RESPONSE',
  'DEVICE_ID_MISMATCH', 'DEVICE_ID_REQUIRED', 'INVALID_QUEUE_LIMIT',
  'DEVICE_REGISTRATION_FAILED', 'INVALID_USER_TOKEN', 'REGISTRATION_RATE_LIMITED',
  'INVALID_REGISTRATION_KEY', 'INVALID_INSTALL_GRANT', 'INVALID_SERVER_URL',
  'SERVICE_COMMAND_FAILED', 'SERVICE_UNLOAD_TIMEOUT', 'INVALID_HOOKS_CONFIG',
  'CONFIG_FILE_UNAVAILABLE', 'EXISTING_DEVICE_CONFIG',
 ]);
 if (known.has(message)) return message;
 const systemCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
 if (/^(?:E[A-Z0-9_]{2,30}|SQLITE_[A-Z0-9_]{2,30})$/.test(systemCode)) return systemCode;
 return 'UNEXPECTED_ERROR';
}
async function main(): Promise<void> {
 const configPath=defaultConfigPath();
 const paths={configPath,hooksPath:defaultHooksConfigPath(process.env.CODEX_HOME || resolve(homedir(),'.codex')),cliPath:fileURLToPath(new URL('./cli.js',import.meta.url)),nodePath:process.execPath};
 let input: CollectorConfig;
 const registrationKeyPath=`${configPath}.registration-id`;
 let existing: Awaited<ReturnType<typeof prepareExistingInstall>>;
 try { existing=await prepareExistingInstall(paths,process.env.COLLECTOR_SERVER_URL,fetch,Boolean(process.env.COLLECTOR_ENROLLMENT_GRANT)); }
 catch(error) {
  if (!(error instanceof Error) || error.message !== 'MIGRATION_REENROLL_REQUIRED' || !process.env.COLLECTOR_ENROLLMENT_GRANT) throw error;
  const previous=loadCollectorConfig(configPath,true);
  await adoptExistingDevice(process.env.COLLECTOR_SERVER_URL ?? previous.serverUrl,process.env.COLLECTOR_ENROLLMENT_GRANT,previous);
  existing=await prepareExistingInstall(paths,process.env.COLLECTOR_SERVER_URL,fetch,true);
 }
 if(existing) {
  input=existing.config;
  await rm(registrationKeyPath,{force:true});
  console.log(`发现已有安装：Hooks ${existing.inspection.hasManagedHooks ? '已存在' : '缺失'}，采集脚本 ${existing.inspection.hasCollectorScript ? '已存在' : '缺失'}，后台服务 ${existing.inspection.hasService ? '已存在' : '缺失'}。`);
  if(existing.migrating) console.log(`迁移方案：目标服务器已确认设备 ${input.deviceId}；保留设备身份和本地队列，更新服务器地址并修复安装。`);
 } else {
  setupPhase = '设备注册';
  const credential = await resolveRegistrationCredential(process.env.COLLECTOR_ENROLLMENT_GRANT, promptForDashboardToken);
  const serverUrl=process.env.COLLECTOR_SERVER_URL || 'https://codex-status-dashboard.vercel.app';
  const idempotencyKey=await loadRegistrationKey(registrationKeyPath);
  const created=await registerDevice(serverUrl,credential,hostname().trim().slice(0,120) || 'Codex device',idempotencyKey);
  input={schemaVersion:1,...created,serverUrl,queuePath:'./events.sqlite'};
 }
 // Validate credentials and SQLite with a real heartbeat before installing a service.
 const { openQueue }=await import('./queue');
 const { createCollectorClient }=await import('./client');
 const queuePath=isAbsolute(input.queuePath) ? input.queuePath : resolve(dirname(configPath),input.queuePath);
 setupPhase = '本地队列';
 const queue=openQueue(queuePath,100_000_000,input.deviceId);
 const { heartbeatPayload }=await import('./heartbeat');
 setupPhase = '首次心跳';
 try {
  const client = createCollectorClient(input);
  const payload = heartbeatPayload(queue,randomUUID());
  await verifyFirstHeartbeat(() => client.heartbeat(payload,15_000));
 } finally { queue.close(); }
 try {
  setupPhase = '写入配置和 Hooks';
  await configureCollector(paths,input,{allowServerMigration:existing?.migrating});
  await rm(registrationKeyPath,{force:true});
  if(!process.argv.includes('--no-service')) {
   setupPhase = '启动后台服务';
   await installService(paths);
  }
 } catch(error) {
  if(existing?.migrating) {
    try { await configureCollector(paths,existing.previous,{allowServerMigration:true}); }
    catch { console.error('无法自动恢复旧地址；请从配置备份恢复。'); }
  }
  throw error;
 }
 console.log('设备认证及首次心跳上报成功。');
 console.log('配置和 Hooks 已安装。请在 Codex 的 /hooks 中审核并信任新增 Hooks。');
 console.log(process.argv.includes('--no-service') ? `前台运行：${process.execPath} ${paths.cliPath} run` : '后台上报服务已启动；设备状态可在看板中查看。');
}

async function promptForDashboardToken(): Promise<string> {
  // Read from the terminal even when the installer was piped into bash.
  const fd=openSync('/dev/tty','r');
  const reader=new ReadStream(fd);
  const writer=new WriteStream(openSync('/dev/tty','w'));
  const restoreEcho=()=>{spawnSync('stty',['echo'],{stdio:[fd,'inherit','inherit']});};
  const interrupted=()=>{restoreEcho();reader.destroy();writer.destroy();process.exit(130);};
  process.once('SIGINT',interrupted);
  process.once('SIGTERM',interrupted);
  const terminal=createInterface({input:reader,output:writer,terminal:false});
  try {
   if (spawnSync('stty',['-echo'],{stdio:[fd,'inherit','inherit']}).status !== 0) throw new Error('TERMINAL_REQUIRED');
   writer.write('Dashboard 用户 Token（隐藏输入）: ');
   try { return (await terminal.question('')).trim(); } finally { spawnSync('stty',['echo'],{stdio:[fd,'inherit','inherit']}); writer.write('\n'); }
  } finally { restoreEcho();process.off('SIGINT',interrupted);process.off('SIGTERM',interrupted);terminal.close();reader.destroy();writer.end(); }
}

if(process.argv[1] && import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href) main().catch(error=>{
 const code=(error as Error).message;
 if(code==='MIGRATION_REENROLL_REQUIRED') console.error('目标服务器不认可现有设备。请使用该服务器新生成的一次性安装命令迁移；安装器未修改本地配置和队列。');
 else if(code==='MIGRATION_DEVICE_CONFLICT') console.error('目标服务器已有相同设备 ID 或 Token，请检查设备迁移记录；安装器未修改本地配置和队列。');
 else if(code==='MIGRATION_DEVICE_MISMATCH') console.error('目标服务器返回的设备 ID 与本机不符。安装器未修改本地配置和队列。');
 else if(code==='MIGRATION_TARGET_UNAVAILABLE') console.error('无法验证目标服务器的设备身份接口。请确认新服务已部署且可访问后重试；安装器未修改本地配置和队列。');
 else if(code==='PARTIAL_INSTALL_WITHOUT_CONFIG') console.error('检测到残留的 Hooks、后台服务或事件队列，但没有设备配置。请先恢复原配置或备份旧队列，再执行首次安装。');
 else console.error(`${setupPhase}阶段失败（${safeSetupErrorCode(error)}）。安装未完成；已有配置不会被覆盖。`);
 process.exitCode=1;
});
