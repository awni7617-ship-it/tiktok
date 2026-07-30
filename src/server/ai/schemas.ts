import { z } from 'zod';
import type { ContentNiche, GeneratedContent } from '@/lib/types';

/**
 * Schemas for structured LLM output.
 *
 * These are the contract between the model and the rest of the system. Every
 * field is bounded — max lengths, array caps, enums — because an unbounded
 * model response becomes an unbounded database write and an unbounded render
 * job. Validation failures are treated as provider errors and retried.
 */

export const NICHES = [
  'scary-story',
  'mystery',
  'reddit-story',
  'educational',
  'motivational',
  'gaming',
  'football',
  'history',
  'finance',
  'business',
  'technology',
  'science',
  'documentary',
  'product-review',
  'news-summary',
  'storytelling',
] as const satisfies readonly ContentNiche[];

export const nicheSchema = z.enum(NICHES);

export const sceneSchema = z.object({
  index: z.number().int().min(0).max(200),
  narration: z.string().min(1).max(1200),
  visual: z.string().min(1).max(600),
  brollQueries: z.array(z.string().min(1).max(80)).max(6).default([]),
  estimatedDurationSec: z.number().min(0.5).max(120),
  overlayText: z.string().max(120).optional(),
});

export const generatedContentSchema = z.object({
  title: z.string().min(1).max(120),
  titleVariants: z.array(z.string().min(1).max(120)).max(6).default([]),
  hook: z.string().min(1).max(300),
  hookVariants: z.array(z.string().min(1).max(300)).max(6).default([]),
  script: z.string().min(1).max(20000),
  scenes: z.array(sceneSchema).min(1).max(60),
  description: z.string().max(2200),
  hashtags: z.array(z.string().min(1).max(60)).max(30).default([]),
  callToAction: z.string().max(200),
  thumbnailIdeas: z.array(z.string().min(1).max(240)).max(6).default([]),
  estimatedDurationSec: z.number().min(1).max(1800),
  niche: nicheSchema,
});

export type GeneratedContentInput = z.input<typeof generatedContentSchema>;

/** Runtime validation with a domain-typed result. */
export function parseGeneratedContent(value: unknown): GeneratedContent {
  return generatedContentSchema.parse(value) as GeneratedContent;
}

// ---------------------------------------------------------------------------
// Optimizer & analytics
// ---------------------------------------------------------------------------

export const llmSuggestionSchema = z.object({
  area: z.enum([
    'hook',
    'pacing',
    'retention',
    'captions',
    'audio',
    'visual',
    'title',
    'thumbnail',
    'hashtags',
    'cta',
    'length',
    'accessibility',
  ]),
  title: z.string().min(1).max(140),
  detail: z.string().min(1).max(800),
  impact: z.enum(['high', 'medium', 'low']),
  /** Optional concrete replacement text the user can accept in one click. */
  replacement: z.string().max(600).optional(),
});

export const llmSuggestionsSchema = z.object({
  suggestions: z.array(llmSuggestionSchema).max(12),
  summary: z.string().max(1200),
});

export const analyticsInsightSchema = z.object({
  summary: z.string().min(1).max(1200),
  wins: z.array(z.string().min(1).max(300)).max(5),
  concerns: z.array(z.string().min(1).max(300)).max(5),
  actions: z.array(z.string().min(1).max(300)).max(5),
});

export type AnalyticsInsight = z.infer<typeof analyticsInsightSchema>;

// ---------------------------------------------------------------------------
// JSON Schema conversion
// ---------------------------------------------------------------------------

/**
 * Minimal Zod → JSON Schema conversion covering the subset the structured
 * output API accepts (objects, arrays, strings, numbers, booleans, enums,
 * optionals, defaults). A general-purpose converter is a large dependency for
 * a handful of schemas that are all defined in this file.
 */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName: string } & Record<string, unknown>;

  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value);
        if (!isOptional(value)) required.push(key);
      }

      return {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      };
    }

    case 'ZodArray': {
      const inner = (def['type'] as z.ZodTypeAny) ?? z.unknown();
      return { type: 'array', items: toJsonSchema(inner) };
    }

    case 'ZodString':
      return { type: 'string' };

    case 'ZodNumber':
      return { type: (def['checks'] as { kind: string }[] | undefined)?.some((c) => c.kind === 'int')
        ? 'integer'
        : 'number' };

    case 'ZodBoolean':
      return { type: 'boolean' };

    case 'ZodEnum':
      return { type: 'string', enum: def['values'] as string[] };

    case 'ZodOptional':
    case 'ZodDefault':
      return toJsonSchema(def['innerType'] as z.ZodTypeAny);

    case 'ZodNullable':
      return {
        anyOf: [toJsonSchema(def['innerType'] as z.ZodTypeAny), { type: 'null' }],
      };

    default:
      // Unknown node: accept anything rather than emitting an invalid schema.
      return {};
  }
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const typeName = (schema._def as { typeName: string }).typeName;
  return typeName === 'ZodOptional' || typeName === 'ZodDefault';
}
