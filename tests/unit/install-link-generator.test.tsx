// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InstallLinkGenerator from '../../src/components/install-link-generator';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('install link generator', () => {
  it('requests a CSRF token, generates an enrollment link, and displays the command with its expiry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ csrfToken: 'c'.repeat(43) }))
      .mockResolvedValueOnce(Response.json({
        installUrl: 'http://localhost:3000/api/collector/install?grant=' + 'g'.repeat(43),
        expiresAt: '2026-09-22T12:15:00.000Z',
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<InstallLinkGenerator />);
    fireEvent.click(screen.getByRole('button', { name: '生成一次性安装命令' }));

    await waitFor(() => expect(screen.getByRole('code')).toHaveTextContent(
      "curl -fsSL 'http://localhost:3000/api/collector/install?grant=" + 'g'.repeat(43) + "' | bash",
    ));
    expect(screen.getByText(/有效期至 2026-09-22 12:15 UTC/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/auth/session', expect.objectContaining({ method: 'GET', cache: 'no-store' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/devices/install-link', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-CSRF-Token': 'c'.repeat(43) }),
      body: '{}',
    }));
  });

  it('accepts the collector origin explicitly returned by the server', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ csrfToken: 'c'.repeat(43) }))
      .mockResolvedValueOnce(Response.json({
        installUrl: 'https://collector.example/api/collector/install?grant=' + 'g'.repeat(43),
        collectorOrigin: 'https://collector.example',
        expiresAt: '2026-09-22T12:15:00.000Z',
      })));
    render(<InstallLinkGenerator />);
    fireEvent.click(screen.getByRole('button', { name: '生成一次性安装命令' }));
    await waitFor(() => expect(screen.getByRole('code')).toHaveTextContent(
      "curl -fsSL 'https://collector.example/api/collector/install?grant=" + 'g'.repeat(43) + "' | bash",
    ));
  });

  it('rejects a link outside the server-approved collector origin', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ csrfToken: 'c'.repeat(43) }))
      .mockResolvedValueOnce(Response.json({
        installUrl: 'https://other.example/api/collector/install?grant=' + 'g'.repeat(43),
        collectorOrigin: 'https://collector.example',
        expiresAt: '2026-09-22T12:15:00.000Z',
      })));
    render(<InstallLinkGenerator />);
    fireEvent.click(screen.getByRole('button', { name: '生成一次性安装命令' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('服务器返回的安装链接无效。'));
    expect(screen.queryByRole('code')).not.toBeInTheDocument();
  });
});
