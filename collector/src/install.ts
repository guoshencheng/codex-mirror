import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export const managedMarker = '--managed-by=codex-status-dashboard';
export const hookEvents = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd',
] as const;
export type ManagedHookEvent = typeof hookEvents[number];

export interface InstallOptions {
  nodePath?: string;
  cliPath?: string;
  dryRun?: boolean;
  configPath?: string;
}

export interface InstallResult {
  config: Record<string, unknown>;
  json: string;
  changed: boolean;
  backupPath: string | null;
  trustNotice: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function shellQuote(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

function isManaged(command: unknown): boolean {
  return typeof command === 'string' && command.includes(managedMarker);
}

function validateConfig(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error('INVALID_HOOKS_CONFIG');
  if (value.hooks === undefined) return { ...value, hooks: {} };
  if (!record(value.hooks)) throw new Error('INVALID_HOOKS_CONFIG');
  for (const entries of Object.values(value.hooks)) {
    if (!Array.isArray(entries)) throw new Error('INVALID_HOOKS_CONFIG');
    for (const group of entries) {
      if (!record(group) || !Array.isArray(group.hooks) || !group.hooks.every(record)) {
        throw new Error('INVALID_HOOKS_CONFIG');
      }
    }
  }
  return { ...value, hooks: { ...value.hooks } };
}

async function readConfig(path: string): Promise<{ config: Record<string, unknown>; original: string | null; mode: number }> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { config: validateConfig({}), original: null, mode: 0o600 };
    throw new Error('HOOKS_CONFIG_UNAVAILABLE');
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('HOOKS_CONFIG_UNAVAILABLE');
  if (info.size > 1_000_000) throw new Error('INVALID_HOOKS_CONFIG');
  let original: string;
  let parsed: unknown;
  try { original = await readFile(path, 'utf8'); parsed = JSON.parse(original); }
  catch { throw new Error('INVALID_HOOKS_CONFIG'); }
  return { config: validateConfig(parsed), original, mode: info.mode & 0o777 };
}

function withoutManagedHandlers(hooks: Record<string, unknown>): Record<string, unknown[]> {
  const cleaned: Record<string, unknown[]> = {};
  for (const [event, value] of Object.entries(hooks)) {
    const groups = value as Array<Record<string, unknown>>;
    const kept = groups.flatMap(group => {
      const handlers = group.hooks as Array<Record<string, unknown>>;
      const remaining = handlers.filter(handler => !isManaged(handler.command));
      if (remaining.length === handlers.length) return [group];
      if (remaining.length === 0) {
        const { hooks: _removed, ...rest } = group;
        return Object.keys(rest).length > 0 ? [{ ...rest, hooks: remaining }] : [];
      }
      return [{ ...group, hooks: remaining }];
    });
    if (kept.length > 0) cleaned[event] = kept;
  }
  return cleaned;
}

async function saveConfig(path: string, json: string, mode: number, original: string | null): Promise<string | null> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const backupPath = original === null ? null : `${path}.${new Date().toISOString().replaceAll(':', '-')}.${randomUUID()}.bak`;
  if (backupPath) {
    await copyFile(path, backupPath);
    await chmod(backupPath, mode);
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, json, { encoding: 'utf8', mode, flag: 'wx' });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return backupPath;
}

function buildMergedConfig(config: Record<string, unknown>, options: InstallOptions): Record<string, unknown> {
  const nodePath = resolve(options.nodePath ?? process.execPath);
  const cliPath = resolve(options.cliPath ?? process.argv[1] ?? 'collector/src/cli.ts');
  const prior = withoutManagedHandlers(config.hooks as Record<string, unknown>);
  for (const event of hookEvents) {
    const prefix = options.configPath ? `COLLECTOR_CONFIG=${shellQuote(resolve(options.configPath))} ` : '';
    const command = `${prefix}${shellQuote(nodePath)} ${shellQuote(cliPath)} hook ${event} ${managedMarker}`;
    const handler = { type: 'command', command, timeout: 3 };
    const current = prior[event] ?? [];
    prior[event] = [...current, { hooks: [handler] }];
  }
  return { ...config, hooks: prior };
}

export async function installHooks(path: string, options: InstallOptions = {}): Promise<InstallResult> {
  const loaded = await readConfig(path);
  const config = buildMergedConfig(loaded.config, options);
  const json = `${JSON.stringify(config, null, 2)}\n`;
  const changed = loaded.original !== json;
  const backupPath = changed && !options.dryRun ? await saveConfig(path, json, loaded.mode, loaded.original) : null;
  return {
    config,
    json,
    changed,
    backupPath,
    trustNotice: 'Open Codex and review/trust the new hooks in /hooks before they run.',
  };
}

export async function uninstallHooks(path: string, dryRun = false): Promise<InstallResult> {
  const loaded = await readConfig(path);
  const hooks = withoutManagedHandlers(loaded.config.hooks as Record<string, unknown>);
  const config = { ...loaded.config, ...(Object.keys(hooks).length ? { hooks } : {}) };
  if (Object.keys(hooks).length === 0) delete config.hooks;
  const json = `${JSON.stringify(config, null, 2)}\n`;
  const changed = loaded.original !== null && loaded.original !== json;
  const backupPath = changed && !dryRun ? await saveConfig(path, json, loaded.mode, loaded.original) : null;
  return { config, json, changed, backupPath, trustNotice: '' };
}

export function defaultHooksConfigPath(codexHome: string): string {
  return resolve(codexHome, 'hooks.json');
}

export function isAbsoluteConfigPath(path: string): boolean {
  return isAbsolute(path);
}
