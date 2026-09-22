import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import type { CollectorQueue } from './queue';

export interface ProjectIdentity {
  projectKey: string;
  projectName?: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function normalizeGitRemote(remote: string): string | null {
  if (!remote || remote.length > 2_048 || /[\u0000-\u001f\u007f]/.test(remote)) return null;
  try {
    let host: string;
    let pathname: string;
    if (/^[^/@:]+@[^/:]+:.+$/.test(remote)) {
      const match = /^(?:[^@]+@)?([^/:]+):(.+)$/.exec(remote);
      if (!match) return null;
      host = match[1]!;
      pathname = match[2]!;
    } else {
      const url = new URL(remote);
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return null;
      host = url.hostname;
      pathname = url.pathname;
    }
    const cleanPath = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    if (!host || !cleanPath) return null;
    const normalizedHost = host.toLowerCase();
    const normalizedPath = cleanPath.split('/').map(part => decodeURIComponent(part)).join('/');
    return `${normalizedHost}/${normalizedPath}`;
  } catch { return null; }
}

export function projectIdentity(deviceId: string, resolvedPath: string, remote: string | null): ProjectIdentity {
  const normalized = remote ? normalizeGitRemote(remote) : null;
  if (normalized) {
    const name = normalized.split('/').at(-1)?.slice(0, 160);
    return { projectKey: `repo:${hash(normalized)}`, ...(name ? { projectName: name } : {}) };
  }
  return { projectKey: `local:${hash(`${deviceId}\0${resolvedPath}`)}` };
}

function git(cwd: string, args: string[]): string | null {
  try {
    const value = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', timeout: 500, maxBuffer: 4_096,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
        NODE_ENV: 'production',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
      },
    }).trim();
    return value || null;
  } catch { return null; }
}

export function resolveProject(cwd: unknown, deviceId: string, queue: Pick<CollectorQueue, 'getProjectCache' | 'putProjectCache'>): ProjectIdentity | null {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4_096) return null;
  let directory: string;
  try { directory = realpathSync(resolve(cwd)); }
  catch { return null; }
  const root = git(directory, ['rev-parse', '--show-toplevel']) ?? directory;
  const cacheKey = hash(root);
  const cached = queue.getProjectCache(cacheKey);
  if (cached) return cached;
  const remote = git(root, ['remote', 'get-url', 'origin']);
  const result = projectIdentity(deviceId, root, remote);
  queue.putProjectCache(cacheKey, result);
  return result;
}
