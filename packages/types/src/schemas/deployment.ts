// packages/types/src/schemas/deployment.ts
import { z } from 'zod';
import { DEPLOYMENT_STATUSES } from '../domain/state-machine.js';

// Readonly tuple passed directly so Deployment['status'] stays the literal union
export const DeploymentStatusSchema = z.enum(DEPLOYMENT_STATUSES);

export const DeploymentSchema = z.object({
  id: z.string().uuid(),
  pullRequestId: z.string().uuid(),
  commitSha: z.string().length(40),
  generation: z.number().int().positive(),
  subdomain: z.string().max(120),
  status: DeploymentStatusSchema,
  containerId: z.string().max(64).nullable(),
  imageTag: z.string().max(128).nullable(),
  buildDurationMs: z.number().int().nonnegative().nullable(),
  failureReason: z.string().max(512).nullable(),
  logArchiveKey: z.string().max(255).nullable(),
  expiresAt: z.date(),
  updatedAt: z.date(),
  createdAt: z.date(),
});

export type Deployment = z.infer<typeof DeploymentSchema>;

export const DeploymentEventSchema = z.object({
  id: z.string().uuid(),
  deploymentId: z.string().uuid(),
  fromStatus: DeploymentStatusSchema.nullable(),
  toStatus: DeploymentStatusSchema,
  reason: z.string().max(512).nullable(),
  createdAt: z.date(),
});

export type DeploymentEvent = z.infer<typeof DeploymentEventSchema>;

