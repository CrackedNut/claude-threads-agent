/**
 * Tests for the live !model choice list (models.ts).
 */

import { describe, it, expect } from 'bun:test';
import {
  buildModelChoices,
  parseCredentialsJson,
  fetchLiveModelChoices,
  modelLabel,
  FALLBACK_MODEL_CHOICES,
  type ApiModel,
} from './models.js';

// A snapshot of a real GET /v1/models response (2026-08-11)
const LIVE_MODELS: ApiModel[] = [
  { id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-07-24T00:00:00Z' },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-06-29T00:00:00Z' },
  { id: 'claude-fable-5', display_name: 'Claude Fable 5', created_at: '2026-06-07T00:00:00Z' },
  { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-05-28T00:00:00Z' },
  { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', created_at: '2026-04-14T00:00:00Z' },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-02-17T00:00:00Z' },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-15T00:00:00Z' },
  { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', created_at: '2025-09-29T00:00:00Z' },
];

describe('buildModelChoices', () => {
  it('picks the newest model per family in display order, plus Default', () => {
    const choices = buildModelChoices(LIVE_MODELS);
    expect(choices.map((c) => c.label)).toEqual([
      'Opus 5',
      'Sonnet 5',
      'Haiku 4.5',
      'Fable 5',
      'Default (inherit)',
    ]);
  });

  it('applies the [1m] suffix to opus and fable only', () => {
    const choices = buildModelChoices(LIVE_MODELS);
    const byLabel = Object.fromEntries(choices.map((c) => [c.label, c.value]));
    expect(byLabel['Opus 5']).toBe('claude-opus-5[1m]');
    expect(byLabel['Fable 5']).toBe('claude-fable-5[1m]');
    expect(byLabel['Sonnet 5']).toBe('claude-sonnet-5');
    expect(byLabel['Haiku 4.5']).toBe('claude-haiku-4-5-20251001');
    expect(byLabel['Default (inherit)']).toBeNull();
  });

  it('never exceeds 5 choices (the 1️⃣–5️⃣ reaction limit)', () => {
    expect(buildModelChoices(LIVE_MODELS).length).toBeLessThanOrEqual(5);
  });

  it('skips families with no models and ignores unknown ids', () => {
    const choices = buildModelChoices([
      { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-06-29T00:00:00Z' },
      { id: 'some-unrelated-model', display_name: 'Other', created_at: '2026-07-01T00:00:00Z' },
    ]);
    expect(choices.map((c) => c.label)).toEqual(['Sonnet 5', 'Default (inherit)']);
  });
});

describe('parseCredentialsJson', () => {
  it('extracts the OAuth access token', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-abc' } });
    expect(parseCredentialsJson(raw)).toBe('sk-ant-oat01-abc');
  });

  it('returns null for malformed or unexpected JSON', () => {
    expect(parseCredentialsJson('not json')).toBeNull();
    expect(parseCredentialsJson('{}')).toBeNull();
    expect(parseCredentialsJson('{"claudeAiOauth":{}}')).toBeNull();
  });
});

describe('fetchLiveModelChoices', () => {
  const stubFetch = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as Parameters<typeof fetchLiveModelChoices>[0];

  it('builds choices from the API response using the OAuth token', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
      capturedHeaders = init.headers;
      return { ok: true, json: async () => ({ data: LIVE_MODELS }) };
    }) as unknown as Parameters<typeof fetchLiveModelChoices>[0];

    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const choices = await fetchLiveModelChoices(fetchImpl, async () => 'tok-123');
      expect(choices[0].label).toBe('Opus 5');
      expect(capturedHeaders?.['Authorization']).toBe('Bearer tok-123');
      expect(capturedHeaders?.['anthropic-beta']).toBe('oauth-2025-04-20');
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it('throws when no credential is available', async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(
        fetchLiveModelChoices(stubFetch({ data: LIVE_MODELS }), async () => null),
      ).rejects.toThrow('no Claude credential');
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it('throws on a non-ok response', async () => {
    await expect(
      fetchLiveModelChoices(stubFetch({}, false), async () => 'tok'),
    ).rejects.toThrow('models API request failed');
  });

  it('throws when the response has no recognizable models', async () => {
    await expect(
      fetchLiveModelChoices(stubFetch({ data: [] }), async () => 'tok'),
    ).rejects.toThrow('no recognizable models');
  });
});

describe('modelLabel', () => {
  it('labels null as Default (inherit)', () => {
    expect(modelLabel(null)).toBe('Default (inherit)');
    expect(modelLabel(undefined)).toBe('Default (inherit)');
  });

  it('resolves labels from the fallback list', () => {
    expect(modelLabel(FALLBACK_MODEL_CHOICES[0].value)).toBe(FALLBACK_MODEL_CHOICES[0].label);
  });

  it('derives a readable label for unknown raw ids', () => {
    expect(modelLabel('claude-opus-5[1m]')).toBe('opus 5');
    expect(modelLabel('claude-sonnet-9')).toBe('sonnet 9');
  });
});
