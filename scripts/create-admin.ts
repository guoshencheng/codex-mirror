import { createInterface } from 'node:readline/promises';
import { createAdmin } from '../src/server/auth/admin';
import { closeAuthDatabasePool } from '../src/server/auth/database';
import { readHiddenInput } from '../src/server/auth/terminal';

async function main(): Promise<void> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') throw new Error('PASSWORD_PROMPT_REQUIRES_TTY');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const username = (await terminal.question('管理员账号（通常为邮箱）: ')).trim();
    terminal.close();
    const password = await readHiddenInput('管理员密码（至少 12 个字符）: ');
    const confirmation = await readHiddenInput('再次输入密码: ');
    if (password !== confirmation) throw new Error('PASSWORDS_DO_NOT_MATCH');
    const admin = await createAdmin(username, password);
    process.stdout.write(`管理员已创建：${admin.username}\n`);
  } finally {
    terminal.close();
    await closeAuthDatabasePool();
  }
}

main().catch(error => {
  const code = error instanceof Error ? error.message : 'ADMIN_CREATE_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
