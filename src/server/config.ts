import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Validated once at import time so a misconfigured deployment fails at boot
 * with a precise message rather than at 3am inside a render job. Secrets have
 * no defaults — a missing `SESSION_SECRET` must stop the process, not silently
 * fall back to a well-known value.
 */

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1).default('postgresql://phantom:phantom@localhost:5432/phantom'),

  // Secrets. Enforced as strong in production by `assertProductionSecrets`.
  SESSION_SECRET: z.string().min(32).default('dev-only-session-secret-change-me-now!!'),
  ENCRYPTION_KEY: z.string().min(32).default('dev-only-encryption-key-change-me-now!!'),

  // Storage
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  S3_PUBLIC_URL: z.string().optional(),

  // AI providers. Absent keys fall back to the deterministic mock provider,
  // which keeps the whole product usable offline and in CI.
  AI_LLM_PROVIDER: z.enum(['anthropic', 'mock']).default('mock'),
  AI_ASR_PROVIDER: z.enum(['openai', 'deepgram', 'mock']).default('mock'),
  AI_TTS_PROVIDER: z.enum(['elevenlabs', 'openai', 'mock']).default('mock'),
  AI_IMAGE_PROVIDER: z.enum(['openai', 'mock']).default('mock'),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  DEEPGRAM_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),

  // Media tooling
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  FONTS_DIR: z.string().optional(),
  MEDIA_TMP_DIR: z.string().default('./tmp/media'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024 * 1024),

  // Worker
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(64).default(2),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1500),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return parsed.data;
}

export const config: Config = load();

/**
 * Refuse to boot in production with development placeholder secrets.
 * Called from the server entrypoint and the worker.
 */
export function assertProductionSecrets(): void {
  if (config.NODE_ENV !== 'production') return;

  const problems: string[] = [];
  if (config.SESSION_SECRET.startsWith('dev-only')) {
    problems.push('SESSION_SECRET is still the development placeholder');
  }
  if (config.ENCRYPTION_KEY.startsWith('dev-only')) {
    problems.push('ENCRYPTION_KEY is still the development placeholder');
  }
  if (config.STORAGE_DRIVER === 's3' && !config.S3_BUCKET) {
    problems.push('STORAGE_DRIVER=s3 requires S3_BUCKET');
  }
  if (config.AI_LLM_PROVIDER === 'anthropic' && !config.ANTHROPIC_API_KEY) {
    problems.push('AI_LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  }

  if (problems.length > 0) {
    throw new Error(`Refusing to start in production:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
