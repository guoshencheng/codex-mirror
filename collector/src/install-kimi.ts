import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const begin = '# BEGIN codex-status-dashboard Kimi hooks';
const end = '# END codex-status-dashboard Kimi hooks';
const events = [
  'SessionStart', 'TurnStarted', 'PreToolUse', 'PostToolUse',
  'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd',
] as const;

export interface KimiInstallOptions {
  nodePath?: string;
  cliPath?: string;
  configPath?: string;
  dryRun?: boolean;
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function tomlString(value: string): string { return JSON.stringify(value); }

function stripManagedBlock(content: string): string {
  const starts = content.split(begin).length - 1;
  const ends = content.split(end).length - 1;
  if (starts !== ends || starts > 1) throw new Error('INVALID_KIMI_HOOKS_CONFIG');
  if (!starts) return content.trimEnd();
  const start = content.indexOf(begin);
  const finish = content.indexOf(end, start) + end.length;
  if (start > 0 && content[start - 1] !== '\n') throw new Error('INVALID_KIMI_HOOKS_CONFIG');
  if (finish < content.length && content[finish] !== '\n') throw new Error('INVALID_KIMI_HOOKS_CONFIG');
  return `${content.slice(0, start)}${content.slice(finish)}`.trimEnd();
}

export async function installKimiHooks(path: string, options: KimiInstallOptions = {}): Promise<{
  toml: string; changed: boolean; backupPath: string | null;
}> {
  let original: string | null = null;
  let mode = 0o600;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error('INVALID_KIMI_HOOKS_CONFIG');
    mode = info.mode & 0o777;
    original = await readFile(path, 'utf8');
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const nodePath = resolve(options.nodePath ?? process.execPath);
  const cliPath = resolve(options.cliPath ?? process.argv[1] ?? 'collector/src/cli.ts');
  const prefix = options.configPath ? `COLLECTOR_CONFIG=${shellQuote(resolve(options.configPath))} ` : '';
  const rules = events.map(event => {
    const command = `${prefix}${shellQuote(nodePath)} ${shellQuote(cliPath)} hook-kimi ${event}`;
    return `[[hooks]]\nevent = ${tomlString(event)}\ncommand = ${tomlString(command)}\ntimeout = 3`;
  });
  const base = stripManagedBlock(original ?? '');
  const toml = `${base ? `${base}\n\n` : ''}${begin}\n${rules.join('\n\n')}\n${end}\n`;
  const changed = original !== toml;
  let backupPath: string | null = null;
  if (changed && !options.dryRun) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    backupPath = original === null ? null : `${path}.${new Date().toISOString().replaceAll(':', '-')}.${randomUUID()}.bak`;
    if (backupPath) { await copyFile(path, backupPath); await chmod(backupPath, mode); }
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, toml, { encoding: 'utf8', mode, flag: 'wx' });
      await chmod(temporary, mode);
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  return { toml, changed, backupPath };
}

export function defaultKimiConfigPath(home: string): string {
  return resolve(home, '.kimi-code/config.toml');
}
