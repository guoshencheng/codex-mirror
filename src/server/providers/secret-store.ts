import { realpath, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class FileSecretStore {
  constructor(private readonly root: string) {}

  async read(ref: string): Promise<string> {
    if (!ref || isAbsolute(ref) || ref.includes('\\')) {
      throw new Error('INVALID_SECRET_REF');
    }

    const root = await realpath(this.root).catch(() => {
      throw new Error('SECRET_STORE_UNAVAILABLE');
    });
    const candidate = resolve(root, ref);
    const relativePath = relative(root, candidate);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      throw new Error('INVALID_SECRET_REF');
    }

    const target = await realpath(candidate).catch(() => {
      throw new Error('SECRET_NOT_FOUND');
    });
    const targetRelative = relative(root, target);
    if (!targetRelative || targetRelative === '..' || targetRelative.startsWith(`..${sep}`)) {
      throw new Error('INVALID_SECRET_REF');
    }

    const content = await readFile(target, 'utf8').catch(() => {
      throw new Error('SECRET_NOT_READABLE');
    });
    const value = content.replace(/\r?\n$/, '');
    if (!value) throw new Error('SECRET_EMPTY');
    return value;
  }
}
