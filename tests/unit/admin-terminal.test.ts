import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { readHiddenInput } from '../../src/server/auth/terminal';

class FakeTty extends EventEmitter {
  isTTY = true;
  rawModes: boolean[] = [];
  setRawMode(mode: boolean) { this.rawModes.push(mode); }
  resume() {}
}

function captureOutput() {
  let value = '';
  return { write(text: string) { value += text; }, read: () => value };
}

describe('hidden terminal password input', () => {
  it('reads the password without echo and restores canonical mode', async () => {
    const input = new FakeTty();
    const output = captureOutput();
    const answer = readHiddenInput('Password: ', input, output);
    input.emit('data', Buffer.from('private-password\r'));
    await expect(answer).resolves.toBe('private-password');
    expect(output.read()).toBe('Password: \n');
    expect(input.rawModes).toEqual([true, false]);
    expect(input.listenerCount('data')).toBe(0);
  });

  it('handles backspace and restores terminal mode after cancellation', async () => {
    const input = new FakeTty();
    const output = captureOutput();
    const answer = readHiddenInput('Password: ', input, output);
    input.emit('data', Buffer.from('wrongx\u007fcorrect\r'));
    await expect(answer).resolves.toBe('wrongcorrect');
    const cancelled = readHiddenInput('Password: ', input, output);
    input.emit('data', Buffer.from('\u0003'));
    await expect(cancelled).rejects.toThrow('CANCELLED');
    expect(input.rawModes).toEqual([true, false, true, false]);
  });
});
