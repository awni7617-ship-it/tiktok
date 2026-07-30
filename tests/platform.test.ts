import { describe, expect, it, beforeEach } from 'vitest';
import type { EditPlan, PostMetrics, Transcript } from '@/lib/types';
import { runRules, scoreAreas, overallScore, AREA_WEIGHTS } from '@/server/optimizer/rules';
import { optimize, CTA_LIBRARY } from '@/server/optimizer';
import {
  analyzeCadence,
  engagementScore,
  formatSlot,
  nextAvailableSlot,
  recommendSlots,
  scheduleBatch,
} from '@/server/planner';
import {
  aggregate,
  averageRetentionCurve,
  comparePeriods,
  fallbackInsight,
  findDropOff,
  timeSeries,
  topPerformers,
  type PostSummary,
} from '@/server/analytics';
import { PLATFORMS, formatBytes, validateForPlatform } from '@/server/social/platforms';
import { composeCaption } from '@/server/social/publish';
import {
  createPkcePair,
  decryptSecret,
  encryptSecret,
  generateToken,
  hashPassword,
  hashToken,
  needsRehash,
  safeEqual,
  verifyPassword,
} from '@/server/security/crypto';
import { RATE_LIMITS, rateLimit, resetRateLimits } from '@/server/security/rateLimit';
import { permissionsFor, roleCan, roleInWorkspace, can } from '@/server/auth/rbac';
import { buildKey, guessContentType, isAllowedUpload, sanitizeFilename } from '@/server/storage';
import { buildEditPlan } from '@/server/edit/plan';
import { buildMockTranscript, buildWavFile, distributeWordTimings, renderGradientPng, seededRandom } from '@/server/ai/providers/mock';
import { toJsonSchema, generatedContentSchema, parseGeneratedContent } from '@/server/ai/schemas';
import { normalizeContent, buildUserPrompt } from '@/server/ai/generate';
import { MockLlmProvider } from '@/server/ai/providers/mock';
import { generateContent } from '@/server/ai/generate';
import { registerProviders, resetProviders, withRetry } from '@/server/ai/registry';
import { AiError } from '@/server/ai/types';
import { redact } from '@/server/obs/logger';

// ---------------------------------------------------------------------------
// Optimizer
// ---------------------------------------------------------------------------

function planWith(overrides: Partial<EditPlan> = {}): EditPlan {
  const transcript = buildMockTranscript('optimizer');
  const plan = buildEditPlan({
    probe: {
      durationSec: transcript.durationSec,
      width: 1920, height: 1080, fps: 30, hasAudio: true,
      audioChannels: 2, audioSampleRate: 48000,
      videoCodec: 'h264', audioCodec: 'aac', bitrateKbps: 6000,
    },
    transcript,
  });
  return { ...plan, ...overrides };
}

describe('optimizer rules', () => {
  it('flags a greeting opener as high impact', () => {
    const suggestions = runRules({ content: { hook: 'Hey guys, welcome back to my channel' } });
    const hook = suggestions.find((s) => s.title.includes('greeting'));
    expect(hook).toBeDefined();
    expect(hook!.impact).toBe('high');
  });

  it('leaves a strong hook alone', () => {
    const suggestions = runRules({ content: { hook: 'Nobody tells you this.' } });
    expect(suggestions.filter((s) => s.area === 'hook')).toHaveLength(0);
  });

  it('flags a slow start and offers a concrete cut', () => {
    const transcript: Transcript = {
      language: 'en',
      durationSec: 20,
      words: [{ text: 'Hello', start: 2.5, end: 3, confidence: 0.9 }],
      segments: [],
    };

    const suggestion = runRules({ transcript }).find((s) => s.title.includes('dead air'));
    expect(suggestion).toBeDefined();
    expect(suggestion!.action).toEqual({ kind: 'add-cut', value: { start: 0, end: 2.4 } });
  });

  it('flags missing captions as the highest-value fix', () => {
    const suggestion = runRules({ plan: planWith({ captions: [] }) }).find((s) => s.area === 'captions');
    expect(suggestion).toBeDefined();
    expect(suggestion!.scoreDelta).toBeGreaterThanOrEqual(10);
  });

  it('applies platform-specific length targets', () => {
    const plan = planWith();
    plan.cutPlan.outputDurationSec = 150;

    // 150s blows past TikTok's 90s ceiling, but is still inside LinkedIn's
    // 180s window — so both flag it, at different severities.
    const tiktok = runRules({ plan, platform: 'tiktok' }).find((s) => s.area === 'length');
    const linkedin = runRules({ plan, platform: 'linkedin' }).find((s) => s.area === 'length');

    expect(tiktok?.impact).toBe('high');
    expect(linkedin?.impact).toBe('medium');
  });

  it('leaves a clip at the platform sweet spot alone', () => {
    const plan = planWith();
    plan.cutPlan.outputDurationSec = 28;
    expect(runRules({ plan, platform: 'tiktok' }).some((s) => s.area === 'length')).toBe(false);
  });

  it('only asks for a thumbnail on platforms that show one', () => {
    expect(runRules({ platform: 'youtube', content: {} }).some((s) => s.area === 'thumbnail')).toBe(true);
    expect(runRules({ platform: 'tiktok', content: {} }).some((s) => s.area === 'thumbnail')).toBe(false);
  });

  it('attaches evidence to every suggestion', () => {
    const suggestions = runRules({ plan: planWith({ captions: [] }), content: { hook: 'Hey guys welcome' } });
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      expect(suggestion.evidence.length).toBeGreaterThan(0);
    }
  });

  it('sorts high-impact findings first', () => {
    const suggestions = runRules({
      plan: planWith({ captions: [] }),
      content: { hook: 'Hey guys, welcome back', hashtags: [] },
    });
    const impacts = suggestions.map((s) => s.impact);
    const firstLow = impacts.indexOf('low');
    const lastHigh = impacts.lastIndexOf('high');
    if (firstLow !== -1 && lastHigh !== -1) expect(lastHigh).toBeLessThan(firstLow);
  });

  it('scores a clean project at 100 and penalises findings', () => {
    expect(overallScore(scoreAreas([]))).toBe(100);

    const penalised = scoreAreas(runRules({ plan: planWith({ captions: [] }) }));
    expect(penalised.captions).toBeLessThan(100);
  });

  it('weights areas so they sum to one', () => {
    const sum = Object.values(AREA_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('returns a full report without calling the model', async () => {
    const report = await optimize({ plan: planWith(), rulesOnly: true });
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(report.summary.length).toBeGreaterThan(0);
    expect(new Date(report.generatedAt).getTime()).toBeGreaterThan(0);
  });

  it('offers editable CTA templates', () => {
    expect(CTA_LIBRARY.length).toBeGreaterThan(4);
    for (const cta of CTA_LIBRARY) {
      expect(cta.text.length).toBeGreaterThan(0);
      expect(cta.label.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

describe('planner', () => {
  const metrics = (views: number, shares = 0, completion = 0.4) => ({
    views, likes: Math.round(views * 0.1), comments: Math.round(views * 0.01),
    shares, completionRate: completion,
  });

  it('falls back to platform guidance with too little history', () => {
    const slots = recommendSlots('tiktok', []);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => slot.basis === 'platform-guidance')).toBe(true);
    expect(slots[0]!.reason).toContain('more post');
  });

  it('switches to personal data once there is enough of it', () => {
    const history = Array.from({ length: 12 }, (_, i) => ({
      // Every post on a Tuesday at 19:00 UTC.
      publishedAt: new Date(Date.UTC(2026, 0, 6 + i * 7, 19)),
      platform: 'tiktok' as const,
      metrics: metrics(i < 6 ? 10000 : 12000, 50),
    }));

    const slots = recommendSlots('tiktok', history);
    const top = slots[0]!;
    expect(['personal', 'blended']).toContain(top.basis);
    expect(top.sampleSize).toBeGreaterThan(0);
  });

  it('weights shares far above likes', () => {
    const shared = engagementScore(metrics(1000, 100));
    const liked = engagementScore(metrics(1000, 0));
    expect(shared).toBeGreaterThan(liked);
  });

  it('rewards regular spacing over raw volume', () => {
    const regular = Array.from({ length: 8 }, (_, i) => new Date(Date.now() - i * 3.5 * 86400000));
    const bursty = [
      ...Array.from({ length: 6 }, (_, i) => new Date(Date.now() - i * 3600000)),
      new Date(Date.now() - 25 * 86400000),
      new Date(Date.now() - 26 * 86400000),
    ];

    expect(analyzeCadence(regular).consistencyScore).toBeGreaterThan(
      analyzeCadence(bursty).consistencyScore,
    );
  });

  it('calls out a long gap explicitly', () => {
    const dates = [
      new Date(Date.now() - 1 * 86400000),
      new Date(Date.now() - 2 * 86400000),
      new Date(Date.now() - 20 * 86400000),
    ];
    expect(analyzeCadence(dates).recommendation).toMatch(/gap/i);
  });

  it('finds the next free slot in the future', () => {
    const slots = recommendSlots('tiktok', []);
    const next = nextAvailableSlot({ slots, taken: [], from: new Date('2026-03-02T00:00:00Z') });

    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(new Date('2026-03-02T00:00:00Z').getTime());
  });

  it('never double-books inside the spacing window', () => {
    const slots = recommendSlots('tiktok', []);
    const scheduled = scheduleBatch(4, {
      slots,
      taken: [],
      from: new Date('2026-03-02T00:00:00Z'),
      minSpacingHours: 6,
    });

    expect(scheduled.length).toBeGreaterThan(1);
    for (let i = 1; i < scheduled.length; i++) {
      const gapHours = Math.abs(scheduled[i]!.getTime() - scheduled[i - 1]!.getTime()) / 3600000;
      expect(gapHours).toBeGreaterThanOrEqual(6);
    }
  });

  it('formats a slot for display', () => {
    expect(formatSlot({ dayOfWeek: 2, hour: 19 })).toBe('Tuesday 7pm');
    expect(formatSlot({ dayOfWeek: 0, hour: 0 })).toBe('Sunday 12am');
  });
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

describe('analytics', () => {
  const makePost = (overrides: Partial<PostMetrics> & { daysAgo?: number; title?: string } = {}): PostSummary => ({
    postId: `p${Math.random()}`,
    projectTitle: overrides.title ?? 'Post',
    platform: 'tiktok',
    publishedAt: new Date(Date.now() - (overrides.daysAgo ?? 1) * 86400000),
    metrics: {
      views: 1000, likes: 100, comments: 10, shares: 5, saves: 3,
      watchTimeSec: 5000, averageViewDurationSec: 5, completionRate: 0.4,
      followersGained: 2, impressions: 1200, retentionCurve: [],
      ...overrides,
    },
  });

  it('aggregates totals and derives engagement rate from views', () => {
    const totals = aggregate([makePost(), makePost()]);
    expect(totals.posts).toBe(2);
    expect(totals.views).toBe(2000);
    expect(totals.engagementRate).toBeCloseTo(118 / 1000, 4);
  });

  it('returns zeroes rather than NaN for an empty set', () => {
    const totals = aggregate([]);
    expect(totals.engagementRate).toBe(0);
    expect(totals.averageCompletionRate).toBe(0);
  });

  it('fills gaps in the daily series', () => {
    const series = timeSeries([makePost({ daysAgo: 2 })], 'views', { days: 7 });
    expect(series).toHaveLength(7);
    expect(series.filter((point) => point.value > 0)).toHaveLength(1);
  });

  it('reports growth from a zero baseline as null, not infinity', () => {
    const comparison = comparePeriods([makePost({ daysAgo: 1 })], { days: 7 });
    expect(comparison.change.views).toBeNull();
    expect(Number.isFinite(comparison.current.views)).toBe(true);
  });

  it('computes a real percentage change when both periods have data', () => {
    const posts = [
      makePost({ daysAgo: 1, views: 2000 }),
      makePost({ daysAgo: 10, views: 1000 }),
    ];
    expect(comparePeriods(posts, { days: 7 }).change.views).toBe(100);
  });

  it('ranks on engagement quality, not views alone', () => {
    const viral = makePost({ title: 'viral', views: 100000, shares: 5, completionRate: 0.1 });
    const quality = makePost({ title: 'quality', views: 20000, shares: 4000, completionRate: 0.8 });

    const ranked = topPerformers([viral, quality], 2);
    expect(ranked[0]!.projectTitle).toBe('quality');
  });

  it('averages retention curves of differing lengths', () => {
    const curve = averageRetentionCurve([
      makePost({ retentionCurve: [1, 0.8, 0.6] }),
      makePost({ retentionCurve: [1, 0.6, 0.4, 0.2] }),
    ]);
    expect(curve).toHaveLength(4);
    expect(curve[1]).toBeCloseTo(0.7, 4);
  });

  it('locates the sharpest drop-off', () => {
    const drop = findDropOff([1, 0.95, 0.9, 0.4, 0.38]);
    expect(drop).not.toBeNull();
    expect(drop!.atPercent).toBe(75);
  });

  it('returns null for a flat curve', () => {
    expect(findDropOff([1, 1, 1])).toBeNull();
  });

  it('produces a grounded summary without the model', () => {
    const insight = fallbackInsight({
      comparison: comparePeriods([makePost({ daysAgo: 1 }), makePost({ daysAgo: 10 })], { days: 7 }),
      top: [makePost({ title: 'Best one' })],
      periodDays: 7,
      retentionCurve: [1, 0.9, 0.5, 0.4],
    });

    expect(insight.summary.length).toBeGreaterThan(0);
    expect(insight.actions.length).toBeGreaterThan(0);
    // Never promise outcomes.
    expect(insight.summary.toLowerCase()).not.toContain('viral');
  });
});

// ---------------------------------------------------------------------------
// Social
// ---------------------------------------------------------------------------

describe('platform validation', () => {
  it('rejects a video longer than the platform allows', () => {
    const issues = validateForPlatform('youtube', { durationSec: 120 });
    expect(issues.some((i) => i.field === 'duration' && i.severity === 'error')).toBe(true);
  });

  it('accepts a video inside the limits', () => {
    expect(
      validateForPlatform('tiktok', {
        durationSec: 30, aspect: '9:16', sizeBytes: 20_000_000, container: 'mp4',
      }),
    ).toHaveLength(0);
  });

  it('warns rather than blocks on an unusual aspect ratio', () => {
    const issue = validateForPlatform('tiktok', { aspect: '4:5' })[0];
    expect(issue?.severity).toBe('warning');
  });

  it('flags a caption over the platform limit', () => {
    const issues = validateForPlatform('x', { description: 'a'.repeat(500) });
    expect(issues.some((i) => i.field === 'description' && i.severity === 'error')).toBe(true);
  });

  it('warns that scheduling will be handled locally where there is no API', () => {
    const issue = validateForPlatform('x', { scheduledFor: new Date() })[0];
    expect(issue?.field).toBe('scheduling');
    expect(issue?.message).toContain('queue');
  });

  it('declares complete capabilities for every platform', () => {
    for (const [id, platform] of Object.entries(PLATFORMS)) {
      expect(platform.id).toBe(id);
      expect(platform.capabilities.maxDurationSec).toBeGreaterThan(0);
      expect(platform.capabilities.aspectRatios.length).toBeGreaterThan(0);
      expect(platform.oauth.scopes.length).toBeGreaterThan(0);
      expect(platform.permissionSummary.length).toBeGreaterThan(0);
    }
  });

  it('appends hashtags within the caption budget', () => {
    const caption = composeCaption('x', 'a'.repeat(270), ['#one', '#two']);
    expect(caption.length).toBeLessThanOrEqual(280);
    expect(caption).toContain('#one');
  });

  it('caps hashtags at the platform maximum', () => {
    const tags = Array.from({ length: 40 }, (_, i) => `#t${i}`);
    const caption = composeCaption('x', 'Hi', tags);
    expect((caption.match(/#/g) ?? []).length).toBeLessThanOrEqual(5);
  });

  it('formats byte sizes readably', () => {
    expect(formatBytes(1024)).toBe('1.0KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0GB');
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe('security', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$a$b$c$d$e')).toBe(false);
  });

  it('detects hashes that used weaker parameters', () => {
    expect(needsRehash('scrypt$1024$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(needsRehash('bcrypt$whatever')).toBe(true);
  });

  it('round-trips an encrypted secret', () => {
    const secret = 'ya29.a0AfB_byC-example-token';
    const encrypted = encryptSecret(secret);

    expect(encrypted).not.toContain(secret);
    expect(encrypted.startsWith('v1.')).toBe(true);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it('produces a different ciphertext each time', () => {
    expect(encryptSecret('token')).not.toBe(encryptSecret('token'));
  });

  it('refuses to decrypt tampered ciphertext', () => {
    const encrypted = encryptSecret('token');
    const parts = encrypted.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });

  it('rejects a malformed encrypted value', () => {
    expect(() => decryptSecret('not-encrypted')).toThrow('Malformed');
  });

  it('compares strings without leaking length through an exception', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcdef')).toBe(false);
  });

  it('generates distinct high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(tokens.size).toBe(200);
  });

  it('hashes tokens deterministically for storage', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe('abc');
  });

  it('creates a valid PKCE pair', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThan(40);
    expect(challenge).not.toBe(verifier);
    expect(challenge).not.toMatch(/[+/=]/);
  });
});

describe('rate limiting', () => {
  beforeEach(() => resetRateLimits());

  it('allows requests up to the limit then blocks', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await rateLimit('user-1', { max: 3, windowMs: 60_000 })).allowed).toBe(true);
    }
    const blocked = await rateLimit('user-1', { max: 3, windowMs: 60_000 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('tracks keys independently', async () => {
    await rateLimit('a', { max: 1 });
    expect((await rateLimit('b', { max: 1 })).allowed).toBe(true);
  });

  it('uses tighter limits on auth endpoints than the default', () => {
    expect(RATE_LIMITS.login.max).toBeLessThan(50);
    expect(RATE_LIMITS.register.max).toBeLessThan(10);
  });
});

describe('authorization', () => {
  const session = {
    user: { id: 'u1', email: 'a@b.c', name: 'A', avatarUrl: null },
    sessionId: 's1',
    memberships: [
      { workspaceId: 'w1', workspaceName: 'W', workspaceSlug: 'w', role: 'EDITOR' as const },
      { workspaceId: 'w2', workspaceName: 'X', workspaceSlug: 'x', role: 'VIEWER' as const },
    ],
  };

  it('grants owners everything', () => {
    expect(roleCan('OWNER', 'workspace:delete')).toBe(true);
    expect(roleCan('OWNER', 'post:publish')).toBe(true);
  });

  it('withholds workspace deletion from admins', () => {
    expect(roleCan('ADMIN', 'workspace:delete')).toBe(false);
    expect(roleCan('ADMIN', 'member:invite')).toBe(true);
  });

  it('lets editors schedule but not publish', () => {
    expect(roleCan('EDITOR', 'post:schedule')).toBe(true);
    expect(roleCan('EDITOR', 'post:publish')).toBe(false);
  });

  it('keeps viewers read-only', () => {
    expect(permissionsFor('VIEWER')).toEqual(['project:read', 'analytics:read']);
  });

  it('resolves the role per workspace', () => {
    expect(roleInWorkspace(session, 'w1')).toBe('EDITOR');
    expect(roleInWorkspace(session, 'w2')).toBe('VIEWER');
    expect(roleInWorkspace(session, 'other')).toBeNull();
  });

  it('denies access to a workspace the user is not a member of', () => {
    expect(can(session, 'w1', 'project:write')).toBe(true);
    expect(can(session, 'w2', 'project:write')).toBe(false);
    expect(can(session, 'unknown', 'project:read')).toBe(false);
  });
});

describe('storage keys', () => {
  it('namespaces keys by workspace', () => {
    const key = buildKey({ workspaceId: 'ws1', projectId: 'pr1', kind: 'source', filename: 'a.mp4' });
    expect(key).toBe('workspaces/ws1/projects/pr1/source/a.mp4');
  });

  it('strips traversal from a hostile filename', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..')).toBe('file');
    expect(sanitizeFilename('a/b/c.mp4')).toBe('c.mp4');
  });

  it('never lets a crafted id escape the prefix', () => {
    const key = buildKey({ workspaceId: '../../root', kind: 'x', filename: 'a.mp4' });
    expect(key).not.toContain('..');
  });

  it('guesses content types from extensions', () => {
    expect(guessContentType('a.mp4')).toBe('video/mp4');
    expect(guessContentType('a.unknown')).toBe('application/octet-stream');
  });

  it('allows media uploads and rejects executables', () => {
    expect(isAllowedUpload('video/mp4')).toBe(true);
    expect(isAllowedUpload('video/mp4; codecs=avc1')).toBe(true);
    expect(isAllowedUpload('application/x-msdownload')).toBe(false);
    expect(isAllowedUpload('text/html')).toBe(false);
  });
});

describe('logging', () => {
  it('redacts secrets anywhere in the context', () => {
    const redacted = redact({
      accessToken: 'secret-value',
      nested: { refresh_token: 'another', safe: 'visible' },
    }) as Record<string, unknown>;

    expect(redacted['accessToken']).toBe('[redacted]');
    expect((redacted['nested'] as Record<string, unknown>)['refresh_token']).toBe('[redacted]');
    expect((redacted['nested'] as Record<string, unknown>)['safe']).toBe('visible');
  });

  it('serialises errors with their stack', () => {
    const redacted = redact(new Error('boom')) as Record<string, unknown>;
    expect(redacted['message']).toBe('boom');
    expect(redacted['stack']).toBeDefined();
  });

  it('truncates very long strings', () => {
    expect(String(redact('x'.repeat(10_000)))).toContain('[truncated]');
  });
});

// ---------------------------------------------------------------------------
// AI layer
// ---------------------------------------------------------------------------

describe('AI providers', () => {
  beforeEach(() => resetProviders());

  it('is deterministic for the same seed', () => {
    const a = seededRandom('seed');
    const b = seededRandom('seed');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('generates a schema-valid content package offline', async () => {
    registerProviders({ llm: new MockLlmProvider() });

    const result = await generateContent({
      prompt: 'A scary story about a house with a missing room',
      targetDurationSec: 45,
    });

    expect(result.content.niche).toBe('scary-story');
    expect(result.content.scenes.length).toBeGreaterThan(0);
    expect(result.content.hook.length).toBeGreaterThan(0);
    expect(result.content.hashtags.every((tag) => tag.startsWith('#'))).toBe(true);
    // The normaliser must renumber scenes contiguously.
    result.content.scenes.forEach((scene, index) => expect(scene.index).toBe(index));
  });

  it('picks the niche from the prompt', async () => {
    registerProviders({ llm: new MockLlmProvider() });

    const finance = await generateContent({ prompt: 'Explain compound interest and investing' });
    expect(finance.content.niche).toBe('finance');

    const football = await generateContent({ prompt: 'Premier league goal edit' });
    expect(football.content.niche).toBe('football');
  });

  it('validates and rejects malformed content', () => {
    expect(() => parseGeneratedContent({ title: 'only a title' })).toThrow();
  });

  it('converts Zod schemas to strict JSON Schema', () => {
    const schema = toJsonSchema(generatedContentSchema) as Record<string, unknown>;
    expect(schema['type']).toBe('object');
    expect(schema['additionalProperties']).toBe(false);
    expect((schema['required'] as string[]).includes('hook')).toBe(true);

    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['scenes']!['type']).toBe('array');
    expect(properties['niche']!['enum']).toBeDefined();
  });

  it('recomputes scene durations that disagree with the narration', () => {
    const normalized = normalizeContent(
      {
        title: 'T', titleVariants: [], hook: 'H', hookVariants: [], script: 'S',
        scenes: [{ index: 5, narration: 'Two words', visual: 'v', brollQueries: [], estimatedDurationSec: 90 }],
        description: '', hashtags: ['#a', '#a', 'b'], callToAction: '',
        thumbnailIdeas: [], estimatedDurationSec: 90, niche: 'educational',
      },
      { prompt: 'x' },
    );

    expect(normalized.scenes[0]!.estimatedDurationSec).toBeLessThan(10);
    expect(normalized.scenes[0]!.index).toBe(0);
    expect(normalized.hashtags).toEqual(['#a', '#b']);
  });

  it('includes the platform and duration in the prompt', () => {
    const prompt = buildUserPrompt({ prompt: 'idea', targetDurationSec: 30, platform: 'linkedin' });
    expect(prompt).toContain('30 seconds');
    expect(prompt).toContain('LinkedIn');
  });

  it('treats a supplied script as source material to structure', () => {
    expect(buildUserPrompt({ prompt: 'My script', useAsScript: true })).toContain('SCRIPT:');
  });

  it('writes a real, parseable WAV file', () => {
    const wav = buildWavFile(Buffer.alloc(48000 * 2), 48000);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(48000);
    expect(wav.readUInt16LE(34)).toBe(16);
  });

  it('writes a real PNG with the correct signature and chunks', () => {
    const png = renderGradientPng(64, 64, 'seed');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.includes(Buffer.from('IHDR'))).toBe(true);
    expect(png.includes(Buffer.from('IDAT'))).toBe(true);
    expect(png.includes(Buffer.from('IEND'))).toBe(true);
    expect(png.readUInt32BE(16)).toBe(64);
  });

  it('spreads word timings across the synthesised duration', () => {
    const timings = distributeWordTimings('one two three four', 4);
    expect(timings).toHaveLength(4);
    expect(timings[0]!.start).toBe(0);
    expect(timings[3]!.end).toBeCloseTo(4, 1);
    for (let i = 1; i < timings.length; i++) {
      expect(timings[i]!.start).toBeGreaterThanOrEqual(timings[i - 1]!.end - 0.001);
    }
  });

  it('produces a transcript with realistic pauses and fillers', () => {
    const transcript = buildMockTranscript('seed-1');
    expect(transcript.words.length).toBeGreaterThan(20);
    expect(transcript.segments.length).toBeGreaterThan(3);

    const hasPause = transcript.words.some((word, i) =>
      i > 0 && word.start - transcript.words[i - 1]!.end > 0.5,
    );
    expect(hasPause).toBe(true);
  });

  it('retries retryable failures and gives up on permanent ones', async () => {
    let attempts = 0;
    const value = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new AiError('rate limited', 'test', true);
        return 'ok';
      },
      { baseDelayMs: 1 },
    );
    expect(value).toBe('ok');
    expect(attempts).toBe(3);

    let permanentAttempts = 0;
    await expect(
      withRetry(async () => {
        permanentAttempts += 1;
        throw new AiError('bad request', 'test', false);
      }, { baseDelayMs: 1 }),
    ).rejects.toThrow('bad request');
    expect(permanentAttempts).toBe(1);
  });
});
