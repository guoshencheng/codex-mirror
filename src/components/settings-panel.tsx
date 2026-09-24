'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, ConfigProvider, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import type { DashboardDevice, DashboardDto } from '../contracts/dashboard';
import CodexLoginForm from './codex-login-form';
import InstallLinkGenerator from './install-link-generator';
import { useDashboardPolling } from './use-dashboard-polling';
import { DISPLAY_TOKEN_PATTERN, normalizeApiOrigin } from '../lib/display-connection';
import './settings-panel.css';

type ProviderValues = { providerId: 'deepseek' | 'kimi-code-cn'; label: string; apiKey: string };
type DisplayValues = { apiOrigin: string; token: string };
type AccountResult = { ok: true; id: string } | { ok: false; error: string };

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) { window.location.assign('/login'); throw new Error('登录已过期'); }
  if (!response.ok) throw new Error('无法验证登录状态');
  const body = await response.json() as { csrfToken?: unknown };
  if (typeof body.csrfToken !== 'string') throw new Error('无法验证登录状态');
  return body.csrfToken;
}

function deviceStatus(device: DashboardDevice) {
  return device.connection === 'online' ? <Tag color="green">在线</Tag>
    : device.connection === 'stale' ? <Tag color="orange">待确认</Tag> : <Tag>离线</Tag>;
}

export default function SettingsPanel({ initial, initialTab = 'accounts' }: { initial: DashboardDto; initialTab?: 'accounts' | 'devices' | 'display' }) {
  const { data, syncHealthy, refresh, refreshQuota, logout } = useDashboardPolling(initial);
  const [providerForm] = Form.useForm<ProviderValues>();
  const [deviceForm] = Form.useForm<{ name: string }>();
  const [displayForm] = Form.useForm<DisplayValues>();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [accountMode, setAccountMode] = useState<'api' | 'codex'>('api');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [editing, setEditing] = useState<DashboardDevice | null>(null);

  useEffect(() => {
    displayForm.setFieldsValue({
      apiOrigin: localStorage.getItem('display-api-origin') ?? window.location.origin,
      token: sessionStorage.getItem('display-user-token') ?? '',
    });
  }, [displayForm]);

  function saveDisplay(values: DisplayValues) {
    try {
      let origin: string;
      try { origin = normalizeApiOrigin(values.apiOrigin); }
      catch { throw new Error('API 地址无效'); }
      if (!DISPLAY_TOKEN_PATTERN.test(values.token)) throw new Error('用户 Token 无效');
      localStorage.setItem('display-api-origin', origin);
      sessionStorage.setItem('display-user-token', values.token);
      setMessage({ type: 'success', text: '展示连接已保存到当前浏览器会话。' });
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : '保存展示连接失败' });
    }
  }

  async function addAccount(values: ProviderValues) {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch('/api/provider-accounts', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken() },
        body: JSON.stringify({ accounts: [values] }),
      });
      const body = await response.json() as { error?: string; results?: AccountResult[] };
      const result = body.results?.[0];
      if (!response.ok || !result?.ok) throw new Error(result && !result.ok ? result.error : body.error ?? '添加账号失败');
      providerForm.resetFields();
      setMessage({ type: 'success', text: '账号已添加。' });
      await refresh();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : '添加账号失败' });
    } finally { setSaving(false); }
  }

  async function renameDevice(values: { name: string }) {
    if (!editing) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch('/api/devices/rename', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken() },
        body: JSON.stringify({ id: editing.id, name: values.name.trim() }),
      });
      if (!response.ok) throw new Error('保存设备名称失败');
      setEditing(null);
      setMessage({ type: 'success', text: '设备名称已保存。' });
      await refresh();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : '保存设备名称失败' });
    } finally { setSaving(false); }
  }

  return <ConfigProvider theme={{ token: { colorPrimary: '#6752da', borderRadius: 7 } }}>
    <main className="settings-page">
      <header className="settings-header">
        <div>
          <Typography.Text type="secondary">CODEX DESK / 管理</Typography.Text>
          <Typography.Title level={2}>设置</Typography.Title>
          <Typography.Text type="secondary">管理额度账号与采集设备</Typography.Text>
        </div>
        <Space wrap>
          <Link href="/" className="ant-btn ant-btn-default">查看面板</Link>
          <Button onClick={() => void refresh()} loading={!syncHealthy}>同步数据</Button>
          <Button onClick={() => void logout()}>退出登录</Button>
        </Space>
      </header>

      {message ? <Alert className="settings-alert" type={message.type} message={message.text} showIcon closable onClose={() => setMessage(null)} /> : null}
      <Tabs activeKey={activeTab} onChange={key => setActiveTab(key as 'accounts' | 'devices' | 'display')} items={[
        { key: 'accounts', label: '额度账号', children: <div className="settings-grid">
          <Card title="已接入账号">
            <Table rowKey="id" dataSource={data.accounts} pagination={false} scroll={{ x: 650 }}
              locale={{ emptyText: '尚未接入账号' }}
              columns={[
                { title: '名称', dataIndex: 'label', key: 'label' },
                { title: '平台', dataIndex: 'providerId', key: 'providerId' },
                { title: '状态', key: 'status', render: (_, account) => account.errorCode
                  ? <Tag color="red">{account.errorCode}</Tag> : <Tag color="green">{account.refreshStatus === 'idle' ? '正常' : account.refreshStatus}</Tag> },
                { title: '最近成功', dataIndex: 'lastSuccessAt', key: 'lastSuccessAt', render: value => value ? new Date(value).toLocaleString('zh-CN') : '尚无数据' },
                { title: '操作', key: 'action', render: (_, account) => <Button size="small" disabled={account.refreshStatus === 'running' || account.refreshStatus === 'queued'} onClick={() => void refreshQuota(account.id)}>刷新额度</Button> },
              ]} />
          </Card>
          <Card title="添加账号">
            <Tabs activeKey={accountMode} onChange={key => setAccountMode(key as 'api' | 'codex')} items={[
              { key: 'api', label: 'API Key', children: <Form form={providerForm} layout="vertical" onFinish={values => void addAccount(values)} initialValues={{ providerId: 'deepseek' }}>
                <Form.Item name="providerId" label="平台" rules={[{ required: true }]}>
                  <Select options={[{ label: 'DeepSeek', value: 'deepseek' }, { label: 'Kimi Code 中国站', value: 'kimi-code-cn' }]} />
                </Form.Item>
                <Form.Item name="label" label="账号名称" rules={[{ required: true, max: 120 }]}>
                  <Input maxLength={120} placeholder="例如：工作账号" />
                </Form.Item>
                <Form.Item name="apiKey" label="API Key" rules={[{ required: true }]}>
                  <Input.Password autoComplete="off" maxLength={500} />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={saving}>添加并读取额度</Button>
              </Form> },
              { key: 'codex', label: 'Codex 登录', children: <CodexLoginForm onSaved={async () => { await refresh(); }} onBack={() => setAccountMode('api')} /> },
            ]} />
          </Card>
        </div> },
        { key: 'devices', label: '采集设备', children: <div className="settings-grid">
          <Card title="设备状态">
            {data.devices.some(device => device.streamIncomplete) ? <Alert type="warning" showIcon message="有设备报告事件流缺口，请检查采集器队列。" /> : null}
            <Table rowKey="id" dataSource={data.devices} pagination={false} scroll={{ x: 600 }}
              locale={{ emptyText: '尚未接入设备' }}
              columns={[
                { title: '设备', dataIndex: 'name', key: 'name' },
                { title: '连接', key: 'connection', render: (_, device) => deviceStatus(device) },
                { title: '最近上报', dataIndex: 'heartbeatAt', key: 'heartbeatAt', render: value => value ? new Date(value).toLocaleString('zh-CN') : '尚未上报' },
                { title: '操作', key: 'action', render: (_, device) => <Button size="small" onClick={() => { setEditing(device); deviceForm.setFieldsValue({ name: device.name }); }}>改名</Button> },
              ]} />
          </Card>
          <Card title="接入新设备">
            <Typography.Paragraph>在目标设备准备 Node.js 24 或更高版本，然后运行一次性安装命令，并在 Codex 的 /hooks 中信任新增 Hooks。</Typography.Paragraph>
            <Typography.Paragraph>安装授权码 15 分钟有效，只能注册一台设备。安装采集器之前的会话无法回填。</Typography.Paragraph>
            <InstallLinkGenerator />
          </Card>
        </div> },
        { key: 'display', label: '展示连接', children: <Card title="独立展示页" className="settings-display-card">
          <Typography.Paragraph>在此浏览器配置展示页连接。Token 仅保留在当前浏览器会话中；展示页只读取状态，不提供管理操作。</Typography.Paragraph>
          <Form form={displayForm} layout="vertical" onFinish={saveDisplay}>
            <Form.Item name="apiOrigin" label="API 地址" rules={[{ required: true }]}><Input autoComplete="url" /></Form.Item>
            <Form.Item name="token" label="用户 Token" rules={[{ required: true }]}><Input.Password autoComplete="off" /></Form.Item>
            <Space><Button type="primary" htmlType="submit">保存连接</Button><a href="/display/" className="ant-btn ant-btn-default">打开展示页</a></Space>
          </Form>
        </Card> },
      ]} />

      <Modal title="修改设备名称" open={Boolean(editing)} onCancel={() => setEditing(null)}
        onOk={() => void deviceForm.submit()} okText="保存" confirmLoading={saving} destroyOnHidden>
        <Form form={deviceForm} layout="vertical" onFinish={values => void renameDevice(values)}>
          <Form.Item name="name" label="设备显示名" rules={[{ required: true, whitespace: true, max: 120 }]}>
            <Input maxLength={120} />
          </Form.Item>
        </Form>
      </Modal>
    </main>
  </ConfigProvider>;
}
