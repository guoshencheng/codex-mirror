import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startCodexDeviceLogin } from '../../src/server/providers/codex/login-rpc';

async function fakeCodex(response: string): Promise<{ home: string; executable: string }> {
  const home = await mkdtemp(join(tmpdir(), 'codex-login-test-'));
  const executable = join(home, 'fake-codex');
  const source = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') process.stdout.write(JSON.stringify({id:req.id,result:{}})+'\\n');
  if (req.method === 'account/login/start') {
    if (req.params.type !== 'chatgptDeviceCode') process.exit(9);
    process.stdout.write(JSON.stringify({id:req.id,result:${response}})+'\\n');
    setTimeout(() => process.stdout.write(JSON.stringify({method:'account/login/completed',params:{loginId:'11111111-1111-4111-8111-111111111111',success:true,error:null}})+'\\n'), 10);
  }
  if (req.method === 'account/read') process.stdout.write(JSON.stringify({id:req.id,result:{account:{type:'chatgpt',email:'secret@example.com'},requiresOpenaiAuth:true}})+'\\n');
  if (req.method === 'account/rateLimits/read') process.stdout.write(JSON.stringify({id:req.id,result:{rateLimits:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300}}}})+'\\n');
});`;
  await writeFile(executable, source, { mode: 0o700 });
  return { home, executable };
}

describe('Codex device login RPC', () => {
  it('returns only quota after official device-code login', async () => {
    const { home, executable } = await fakeCodex(JSON.stringify({
      type: 'chatgptDeviceCode', loginId: '11111111-1111-4111-8111-111111111111',
      verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234',
    }));
    const codes: unknown[] = [];
    const result = await startCodexDeviceLogin(home, new AbortController().signal, code => { codes.push(code); }, executable, 5000);
    expect(codes).toEqual([{ loginId: '11111111-1111-4111-8111-111111111111', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }]);
    expect(result).toEqual({ rateLimits: { rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300 } } } });
    expect(JSON.stringify(result)).not.toContain('secret@example.com');
  });

  it('rejects a verification link outside OpenAI', async () => {
    const { home, executable } = await fakeCodex(JSON.stringify({
      type: 'chatgptDeviceCode', loginId: '11111111-1111-4111-8111-111111111111',
      verificationUrl: 'https://example.com/steal', userCode: 'ABCD-1234',
    }));
    await expect(startCodexDeviceLogin(home, new AbortController().signal, () => {}, executable, 5000))
      .rejects.toThrow('INVALID_VERIFICATION_URL');
  });

  it('reports an unavailable device-code flow without exposing upstream text', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-login-test-'));
    const executable = join(home, 'fake-codex');
    await writeFile(executable, `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const req=JSON.parse(line);
  if(req.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{}})+'\\n');
  if(req.method==='account/login/start') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{message:'SECRET_CANARY'}})+'\\n');
});`, { mode: 0o700 });
    await expect(startCodexDeviceLogin(home, new AbortController().signal, () => {}, executable, 5000))
      .rejects.toThrow('CODEX_AUTH_UNAVAILABLE');
  });

  it('times out a silent child and rejects an already aborted login', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-login-test-'));
    const executable = join(home, 'silent-codex');
    await writeFile(executable, '#!/usr/bin/env node\nprocess.stdin.resume();\n', { mode: 0o700 });
    await expect(startCodexDeviceLogin(home, new AbortController().signal, () => {}, executable, 25))
      .rejects.toThrow('LOGIN_EXPIRED');
    const controller = new AbortController();
    controller.abort();
    await expect(startCodexDeviceLogin(home, controller.signal, () => {}, executable, 5000))
      .rejects.toThrow('LOGIN_CANCELLED');
  });
});
