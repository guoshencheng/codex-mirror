import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  deviceToken: z.string().min(32).max(256).regex(/^[a-zA-Z0-9_-]+$/),
  serverUrl: z.string().url().max(2_048),
  queuePath: z.string().min(1).max(2_048),
}).strict();

export type CollectorConfig = z.infer<typeof configSchema>;

export function defaultConfigPath(): string {
  return process.env.COLLECTOR_CONFIG || resolve(homedir(), '.config/codex-status-dashboard/config.json');
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

export function loadCollectorConfig(path = defaultConfigPath(), production = process.env.NODE_ENV === 'production'): CollectorConfig {
  let fileInfo;
  try { fileInfo = lstatSync(path); }
  catch { throw new Error('CONFIG_FILE_UNAVAILABLE'); }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('CONFIG_FILE_UNAVAILABLE');
  if ((fileInfo.mode & 0o077) !== 0) throw new Error('CONFIG_FILE_PERMISSIONS');
  if (fileInfo.size > 32_768) throw new Error('INVALID_CONFIG');

  let input: unknown;
  try { input = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('INVALID_CONFIG'); }
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new Error('INVALID_CONFIG');
  const config = parsed.data;
  let url: URL;
  try { url = new URL(config.serverUrl); }
  catch { throw new Error('INVALID_SERVER_URL'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('INVALID_SERVER_URL');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production && isLoopback(url.hostname))) {
    throw new Error('HTTPS_REQUIRED');
  }
  const configDirectory = dirname(resolve(path));
  return {
    ...config,
    serverUrl: url.origin,
    queuePath: isAbsolute(config.queuePath) ? resolve(config.queuePath) : resolve(configDirectory, config.queuePath),
  };
}
