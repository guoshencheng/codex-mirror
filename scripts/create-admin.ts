import { randomInt } from 'node:crypto';
import { open, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const TOKEN_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';

// A new file is required: never overwrite an existing credential backup.
async function main(): Promise<void> {
  const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length);
  if (!output) throw new Error('Use --output=/private/path/user-token.txt');
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'wx', 0o600);
  const token = Array.from({ length: 8 }, () => TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)]).join('');
  try {
    await file.writeFile(token+'\n');
    await file.sync();
    console.log(`用户 Token 已保存到 ${path}（权限 0600）。重新配置服务使用新文件后，旧登录会话即失效。`);
  } finally { await file.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'TOKEN_CREATE_FAILED'); process.exitCode=1; });
