import type { Metadata } from 'next';
import '@fontsource-variable/noto-sans-sc/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Codex Status Dashboard',
  description: '设备事件与 AI Provider 额度状态面板',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
