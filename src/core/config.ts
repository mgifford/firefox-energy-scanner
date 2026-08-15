import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { readFile } from 'node:fs/promises';
import { SUPPORTED_MODELS } from './co2.js';

/**
 * Configuration schema.
 *
 * `.strict()` is used throughout so that an unknown key fails rather than
 * being silently ignored — a typo in a benchmark config must not quietly
 * change what is measured.
 */

const viewportSchema = z
  .object({ width: z.number().int().positive(), height: z.number().int().positive() })
  .strict();

const targetSchema = z
  .object({
    url: z.string().url(),
    label: z.string().optional(),
    commit: z.string().optional(),
  })
  .strict();

const browserSchema = z
  .object({
    name: z.literal('firefox').default('firefox'),
    headed: z.boolean().default(true),
    viewport: viewportSchema.default({ width: 1440, height: 900 }),
  })
  .strict()
  .default({});

const authSchema = z
  .object({
    type: z.enum(['none', 'drupal']).default('none'),
    username_env: z.string().default('DRUPAL_USERNAME'),
    password_env: z.string().default('DRUPAL_PASSWORD'),
    login_path: z.string().default('/user/login'),
  })
  .strict();

const benchmarkSchema = z
  .object({
    warmups: z.number().int().min(0).default(3),
    runs: z.number().int().min(1).default(10),
    settle_ms: z.number().int().min(0).default(1500),
    cache_mode: z.enum(['warm', 'cold-context', 'new-browser']).default('warm'),
  })
  .strict()
  .default({});

const stabilitySchema = z
  .object({
    network_idle_ms: z.number().int().min(0).default(500),
    post_idle_ms: z.number().int().min(0).default(1500),
    max_wait_ms: z.number().int().min(0).default(10000),
  })
  .strict()
  .default({});

const crawlSchema = z
  .object({
    enabled: z.boolean().default(false),
    max_pages: z.number().int().positive().default(100),
    max_depth: z.number().int().min(0).default(5),
    same_origin: z.boolean().default(true),
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
    query_strategy: z.enum(['strip', 'keep']).default('strip'),
    respect_robots: z.boolean().default(true),
    delay_ms: z.number().int().min(0).default(250),
  })
  .strict()
  .default({});

const energySchema = z
  .object({
    adapter: z.enum(['auto', 'firefox-profiler', 'macos-powermetrics', 'noop']).default('auto'),
    baseline: z.boolean().default(true),
    baseline_duration_ms: z.number().int().positive().default(10000),
    /**
     * Idle time discarded before baseline sampling begins. Firefox does
     * significant startup work in its first seconds; sampling immediately
     * produces an inflated idle estimate and therefore negative incremental
     * energy for light pages.
     */
    baseline_settle_ms: z.number().int().min(0).default(5000),
    profiler_interval_ms: z.number().int().positive().default(10),
    retain_profile: z.boolean().default(false),
  })
  .strict()
  .default({});

const co2Schema = z
  .object({
    enabled: z.boolean().default(true),
    model: z.enum(SUPPORTED_MODELS).default('swd'),
    check_green_hosting: z.boolean().default(false),
  })
  .strict()
  .default({});

const outputSchema = z
  .object({
    directory: z.string().default('results'),
    json: z.boolean().default(true),
    csv: z.boolean().default(true),
    html: z.boolean().default(true),
    collect_hostname: z.boolean().default(false),
  })
  .strict()
  .default({});

export const configSchema = z
  .object({
    target: targetSchema.optional(),
    browser: browserSchema,
    auth: authSchema.optional(),
    benchmark: benchmarkSchema,
    stability: stabilitySchema,
    crawl: crawlSchema,
    energy: energySchema,
    co2: co2Schema,
    sitespeed: z.object({ enabled: z.boolean().default(false) }).strict().default({}),
    output: outputSchema,
  })
  .strict();

export type Config = z.infer<typeof configSchema>;

export function defaultConfig(): Config {
  return configSchema.parse({});
}

/** Parse and validate a config object, failing loudly on unknown keys. */
export function validateConfig(raw: unknown): Config {
  return configSchema.parse(raw ?? {});
}

export async function loadConfigFile(path: string): Promise<Config> {
  const text = await readFile(path, 'utf8');
  return validateConfig(parseYaml(text));
}

/** Human-readable validation errors for CLI output. */
export function formatConfigError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
  }
  return String(err);
}
