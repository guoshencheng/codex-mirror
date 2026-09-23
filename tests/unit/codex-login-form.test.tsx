import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ManagedAccountForm from '../../src/components/managed-account-form';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Codex account option', () => {
  it('shows device login instead of an API key field', () => {
    render(<ManagedAccountForm onSaved={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole('button', { name: '登录 Codex' }));
    expect(screen.getByRole('button', { name: '开始 Codex 登录' })).toBeInTheDocument();
    expect(screen.queryByLabelText('DeepSeek API Key')).not.toBeInTheDocument();
  });

  it('shows the official code and refreshes the dashboard after login', async () => {
    const onSaved = vi.fn(async () => {});
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/session') return Response.json({ csrfToken: 'x'.repeat(43) });
      if (url === '/api/provider-accounts/codex-login' && init?.method === 'POST')
        return Response.json({ id: '11111111-1111-4111-8111-111111111111', status: 'queued' }, { status: 202 });
      return Response.json({ id: '11111111-1111-4111-8111-111111111111', status: 'awaiting',
        verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
    }));
    render(<ManagedAccountForm onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: '登录 Codex' }));
    fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: 'Personal' } });
    fireEvent.click(screen.getByRole('button', { name: '开始 Codex 登录' }));
    await waitFor(() => expect(screen.getByText('ABCD-1234')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'OpenAI 授权页面' })).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
    expect(screen.getByRole('link', { name: 'OpenAI 授权页面' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('restores an active request and retains it when cancellation fails', async () => {
    const active = { id: '11111111-1111-4111-8111-111111111111', status: 'awaiting',
      verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', accountId: null, error: null };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/session') return Response.json({ csrfToken: 'x'.repeat(43) });
      if (url === '/api/provider-accounts/codex-login' && !init?.method) return Response.json({ login: active });
      if (init?.method === 'DELETE') return Response.json({ error: 'LOGIN_UNAVAILABLE' }, { status: 503 });
      return Response.json(active);
    }));
    render(<ManagedAccountForm onSaved={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole('button', { name: '登录 Codex' }));
    await waitFor(() => expect(screen.getByText('ABCD-1234')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '取消登录' }));
    await waitFor(() => expect(screen.getByText('取消失败，请稍后重试。')).toBeInTheDocument());
    expect(screen.getByText('ABCD-1234')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回其他平台' }));
    fireEvent.click(screen.getByRole('button', { name: '登录 Codex' }));
    await waitFor(() => expect(screen.getByText('ABCD-1234')).toBeInTheDocument());
  });
});
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
