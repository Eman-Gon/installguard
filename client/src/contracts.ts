import { z } from 'zod';
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const RequestSchema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  package: z.object({ecosystem:z.literal('npm'),name:z.string().min(1),version:z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)}).strict(),
  lockfileDigest:digest, artifact:z.object({digest,reference:z.string().min(1)}).strict(),
  target:z.object({os:z.literal('linux'),arch:z.enum(['x64','arm64']),runtime:z.literal('node'),version:z.string().regex(/^22\.\d+\.\d+$/)}).strict(),
  goal:z.string().min(1).max(4000),testProfile:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
 ,context:z.object({projectId:z.string().regex(/^[a-f0-9]{64}$/),moduleType:z.enum(['module','commonjs']),nodeMajor:z.literal(22)}).strict().optional()
}).strict();
export const PolicySchema = z.object({
  authorizationId:z.string().min(1),providers:z.array(z.string().url()).min(1),network:z.literal('localnet'),
  asset:z.literal('USDC'),paymentType:z.literal('fixed'),perCallLimit:amount,totalLimit:amount,
  expiresAt:z.string().datetime(),testProfiles:z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).min(1)
}).strict();
export const QuoteSchema = z.object({id:z.string().min(1),requestDigest:digest,provider:z.string().url(),
  network:z.literal('localnet'),asset:z.literal('USDC'),paymentType:z.literal('fixed'),amount,
  expiresAt:z.string().datetime(),testProfile:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)}).strict();
export const ResultSchema = z.object({requestId:z.string(),requestDigest:digest,artifactDigest:digest,lockfileDigest:digest,
  target:RequestSchema.shape.target,executionId:z.string().min(1),execution:z.enum(['not_started','queued','running','completed','failed','unknown']),
  finding:z.enum(['reproduced','not_reproduced_by_this_test','inconclusive','not_applicable']),
  installationPolicy:z.enum(['allow','block','review']),exitCode:z.number().int().nullable(),
  logs:z.array(z.string()),evidence:z.array(z.object({reference:z.string(),digest})),limitations:z.array(z.string()),recommendation:z.string(),
  assessment:z.object({functional:z.enum(['passed','failed','not_completed']),vulnerabilities:z.enum(['unknown','reported','none_reported']),vulnerabilityIds:z.array(z.string()),environmentVerified:z.boolean(),failureKind:z.enum(['installation','timeout','functional','infrastructure']).nullable()}).optional(),
  history:z.object({advisoryOnly:z.literal(true),signatureVersion:z.string().optional(),unavailable:z.boolean().optional(),patterns:z.array(z.object({outcome:z.string(),failure_signature:z.string().nullable(),occurrences:z.number().int(),artifacts:z.number().int()})).optional()}).optional(),
  dependencyChecks:z.object({installation:z.enum(['passed','failed','unknown']),compatibility:z.enum(['passed','failed','unknown']),vulnerabilities:z.enum(['unknown','reported','none_reported']),scope:z.array(z.string()),unavailable:z.array(z.string()),recommendations:z.array(z.string())}).strict().optional(),
  fixture:z.boolean()
}).strict();
export type InvestigationRequest = z.infer<typeof RequestSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type InvestigationResult = z.infer<typeof ResultSchema>;
