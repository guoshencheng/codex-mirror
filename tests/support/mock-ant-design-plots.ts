import { vi } from 'vitest';
import { createElement } from 'react';

vi.mock('@ant-design/plots', () => ({
  Line: ({ data }: { data?: unknown[] }) => createElement('div', { 'data-testid': 'antv-line-mock', 'data-points': data?.length ?? 0 }),
}));
