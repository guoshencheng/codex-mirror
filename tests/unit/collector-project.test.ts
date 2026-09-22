import { describe, expect, it } from 'vitest';
import { normalizeGitRemote, projectIdentity } from '../../collector/src/project';

describe('collector project identity', () => {
  it('normalizes HTTPS and SSH remotes while removing userinfo and query secrets', () => {
    const https = normalizeGitRemote('https://alice:SECRET@git.example.com/Team/Project.git?token=SECRET#private');
    const ssh = normalizeGitRemote('git@git.example.com:Team/Project.git');
    expect(https).toBe('git.example.com/Team/Project');
    expect(ssh).toBe(https);
    expect(https).not.toContain('SECRET');
    expect(normalizeGitRemote('git.example.com:Team/Project.git?token=SECRET#fragment')).toBe(https);
  });

  it('uses a hashed project key and a short name rather than storing a full local path', () => {
    const project = projectIdentity('device-a', '/Users/alice/private/project', 'https://git.example.com/acme/service.git');
    expect(project.projectKey).toMatch(/^repo:[a-f0-9]{32}$/);
    expect(project.projectName).toBe('service');
    expect(JSON.stringify(project)).not.toMatch(/alice|private|git\.example/);
  });

  it('uses a device-scoped path hash when no git remote is available', () => {
    const first = projectIdentity('device-a', '/Users/alice/project', null);
    expect(first.projectKey).toMatch(/^local:[a-f0-9]{32}$/);
    expect(first).not.toHaveProperty('projectName');
    expect(projectIdentity('device-b', '/Users/alice/project', null).projectKey).not.toBe(first.projectKey);
  });

  it('rejects unsupported or malformed remote forms', () => {
    expect(normalizeGitRemote('file:///Users/alice/project')).toBeNull();
    expect(normalizeGitRemote('https://git.example.com/')).toBeNull();
    expect(normalizeGitRemote('https://git.example.com/%XX')).toBeNull();
  });
});
