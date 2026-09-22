import { z } from 'zod';
import type { ProviderSnapshot, QuotaMetric } from '../../contracts/quota';
import { ProviderTransportError } from './http';

const detailsSchema = z.array(z.object({
  key: z.string().min(1).max(100),
  label: z.string().min(1).max(160),
  value: z.string().max(200),
}).strict()).max(20).optional();

export const quotaWindowMetricSchema = z.object({
  kind: z.literal('quota-window'),
  key: z.string().min(1).max(160),
  label: z.string().min(1).max(160),
  usedPercent: z.number().finite().min(0).max(100).nullable(),
  windowDurationSeconds: z.number().int().positive().nullable(),
  resetsAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export const balanceMetricSchema = z.object({
  kind: z.literal('balance'),
  key: z.string().min(1).max(160),
  label: z.string().min(1).max(160),
  currency: z.string().regex(/^[A-Z]{3}$/),
  total: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
  granted: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).nullable(),
  toppedUp: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).nullable(),
  details: detailsSchema,
}).strict();

export const quotaMetricSchema = z.discriminatedUnion('kind', [quotaWindowMetricSchema, balanceMetricSchema]);

const providerSnapshotSchema = z.object({
  accountId: z.string().min(1).max(160),
  providerId: z.string().min(1).max(80),
  observedAt: z.string().datetime({ offset: true }),
  metrics: z.array(quotaMetricSchema).max(100),
  serviceAvailable: z.boolean().nullable(),
}).strict();

export function validateProviderSnapshot(value: unknown): ProviderSnapshot {
  const parsed = providerSnapshotSchema.safeParse(value);
  if (!parsed.success) throw new ProviderTransportError('SCHEMA_CHANGED');
  return parsed.data as ProviderSnapshot;
}

export function validateQuotaMetric(value: unknown): QuotaMetric {
  const parsed = quotaMetricSchema.safeParse(value);
  if (!parsed.success) throw new ProviderTransportError('SCHEMA_CHANGED');
  return parsed.data as QuotaMetric;
}
