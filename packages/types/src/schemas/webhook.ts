// packages/types/src/schemas/webhook.ts
// Zod schemas for GitHub pull_request webhook payloads.
// These are the single source of truth — TypeScript types are derived from them.

import { z } from 'zod';

export const GitHubUserSchema = z.object({
  login: z.string().max(128),
  id: z.number().int().positive(),
});

export const GitHubRefSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/i, 'Expected 40-char hex commit SHA'),
  ref: z.string().max(255),
  label: z.string().max(512).optional(),
});

export const GitHubRepositorySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().max(128),
  full_name: z.string().max(260),
  owner: GitHubUserSchema,
  private: z.boolean(),
  default_branch: z.string().max(255).default('main'),
});

export const GitHubPullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(512),
  state: z.enum(['open', 'closed']),
  user: GitHubUserSchema,
  head: GitHubRefSchema,
  base: GitHubRefSchema,
  merged: z.boolean().nullable().default(false),
  draft: z.boolean().default(false),
});

export const PullRequestWebhookPayloadSchema = z.object({
  action: z.enum(['opened', 'synchronize', 'reopened', 'closed']),
  number: z.number().int().positive(),
  pull_request: GitHubPullRequestSchema,
  repository: GitHubRepositorySchema,
  installation: z.object({ id: z.number().int().positive() }).optional(),
  sender: GitHubUserSchema,
});

// Derived TypeScript types — never define these manually
export type PullRequestWebhookPayload = z.infer<typeof PullRequestWebhookPayloadSchema>;
export type GitHubPullRequest = z.infer<typeof GitHubPullRequestSchema>;
export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;

/**
 * Normalised, verified webhook event — the output of HMAC verification +
 * Zod parsing. This is what the service layer receives.
 */
export interface VerifiedPrWebhook {
  deliveryId: string;
  eventType: 'pull_request';
  action: 'opened' | 'synchronize' | 'reopened' | 'closed';
  prNumber: number;
  prTitle: string;
  commitSha: string;
  branchName: string;
  authorLogin: string;
  repoId: string;          // UUID of the repositories row
  installationId: number;
  ttlSeconds: number;
}

