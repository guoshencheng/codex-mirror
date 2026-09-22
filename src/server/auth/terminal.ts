import { StringDecoder } from 'node:string_decoder';

export interface RawTerminalInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume(): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

export interface TerminalOutput {
  write(text: string): unknown;
}

export function readHiddenInput(prompt: string, input: RawTerminalInput = process.stdin, output: TerminalOutput = process.stdout): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return Promise.reject(new Error('PASSWORD_PROMPT_REQUIRES_TTY'));
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  const decoder = new StringDecoder('utf8');

  return new Promise((resolve, reject) => {
    let value = '';
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.off('data', onData);
      input.setRawMode?.(false);
      output.write('\n');
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      for (const character of text) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('CANCELLED'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (character >= ' ' && character !== '\u007f') value += character;
      }
    };
    input.on('data', onData);
  });
}
