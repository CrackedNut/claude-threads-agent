/**
 * The `!model` picker's choices.
 *
 * Index order == the number a user reacts with (1️⃣ = index 0). The `value`
 * is passed verbatim to `claude --model` — Claude Code aliases (`opus`,
 * `sonnet`, `haiku`) always resolve, so they're the safe core; a full model
 * id works too. `value: null` means "clear the override / inherit the
 * configured default" — never a real model.
 *
 * The list is fetched LIVE from the Anthropic Models API (`GET /v1/models`,
 * newest model per family) using the same OAuth credential the spawned
 * Claude CLI runs on, so a newly released model shows up without a deploy.
 * On any failure (no credential, offline, API error) the picker falls back
 * to the static FALLBACK_MODEL_CHOICES below. Keep the result ≤ 5 (we only
 * post 1️⃣–5️⃣).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

export interface ModelChoice {
  label: string;
  /** Passed to `claude --model`; null = inherit / clear override. */
  value: string | null;
}

// NOTE on the `[1m]` suffixes: that's Claude Code's 1-million-token context
// tier. `!model` resumes the existing conversation, so the target model must
// be able to hold the session's CURRENT context — for a large session (e.g.
// 500k+ tokens) a standard-window model can't load it and Claude Code silently
// keeps a 1M-capable model, so the switch appears to "not take". Opus and Fable
// have a working [1m] tier on Pro/Max — use it so the switch holds on big
// sessions. Sonnet/Haiku [1m] aren't available on this subscription (they error
// "usage credits required" / "beta not available"), so they stay standard —
// which also means you can't switch a >~200k-token session TO them (a context
// reality, not a bug).

/** Static fallback when the live model list can't be fetched. */
export const FALLBACK_MODEL_CHOICES: ModelChoice[] = [
  { label: 'Opus 4.8', value: 'claude-opus-4-8[1m]' },
  { label: 'Sonnet 4.6', value: 'sonnet' },
  { label: 'Haiku 4.5', value: 'haiku' },
  { label: 'Fable 5', value: 'claude-fable-5[1m]' },
  { label: 'Default (inherit)', value: null },
];

/** The model families the picker surfaces, in display order. */
const FAMILY_ORDER = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** Families whose Claude Code `[1m]` tier works on this subscription. */
const ONE_M_FAMILIES = new Set<string>(['opus', 'fable']);

/** Shape of a model object from `GET /v1/models` (fields we use). */
export interface ApiModel {
  id: string;
  display_name: string;
  created_at: string;
}

/**
 * Turn the Models API list into picker choices: the newest model per family,
 * in FAMILY_ORDER, plus the "Default (inherit)" entry. Pure — unit tested.
 */
export function buildModelChoices(models: ApiModel[]): ModelChoice[] {
  const newestPerFamily = new Map<string, ApiModel>();
  const sorted = [...models].sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const model of sorted) {
    const family = FAMILY_ORDER.find((f) => model.id.includes(f));
    if (family && !newestPerFamily.has(family)) {
      newestPerFamily.set(family, model);
    }
  }

  const choices: ModelChoice[] = [];
  for (const family of FAMILY_ORDER) {
    const model = newestPerFamily.get(family);
    if (!model) continue;
    choices.push({
      label: model.display_name.replace(/^Claude /, ''),
      value: ONE_M_FAMILIES.has(family) ? `${model.id}[1m]` : model.id,
    });
  }
  choices.push({ label: 'Default (inherit)', value: null });
  return choices.slice(0, 5);
}

/** Extract the OAuth access token from Claude CLI credential JSON. Pure. */
export function parseCredentialsJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    return parsed.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Find the credential the spawned Claude CLI itself runs on: macOS keychain
 * first (where Claude Code stores it), then ~/.claude/.credentials.json
 * (Linux). Returns null when neither is available.
 */
async function getClaudeOAuthToken(): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: 5000 },
      );
      const token = parseCredentialsJson(stdout);
      if (token) return token;
    } catch {
      // fall through to the file
    }
  }
  try {
    const raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8');
    return parseCredentialsJson(raw);
  } catch {
    return null;
  }
}

type FetchLike = (url: string, init: {
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Fetch the live model list and build choices. Throws on any failure —
 * getModelChoices() handles the fallback. Injectable for tests.
 */
export async function fetchLiveModelChoices(
  fetchImpl: FetchLike = fetch,
  tokenProvider: () => Promise<string | null> = getClaudeOAuthToken,
): Promise<ModelChoice[]> {
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  } else {
    const token = await tokenProvider();
    if (!token) throw new Error('no Claude credential available');
    headers['Authorization'] = `Bearer ${token}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  }

  const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=50', {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error('models API request failed');
  const body = (await res.json()) as { data?: ApiModel[] };
  if (!Array.isArray(body.data)) throw new Error('unexpected models API response');

  const choices = buildModelChoices(body.data);
  // A usable picker needs at least one real model plus "Default".
  if (choices.length < 2) throw new Error('no recognizable models in API response');
  return choices;
}

let cachedChoices: { choices: ModelChoice[]; fetchedAt: number } | null = null;
const CHOICES_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * The picker's choices: live list when fetchable (cached 1h), static fallback
 * otherwise. Never throws. Set OPENINTEL_LIVE_MODELS=0 to force the fallback.
 */
export async function getModelChoices(): Promise<ModelChoice[]> {
  if (process.env.OPENINTEL_LIVE_MODELS === '0' || process.env.NODE_ENV === 'test') {
    return FALLBACK_MODEL_CHOICES;
  }
  if (cachedChoices && Date.now() - cachedChoices.fetchedAt < CHOICES_CACHE_TTL_MS) {
    return cachedChoices.choices;
  }
  try {
    const choices = await fetchLiveModelChoices();
    cachedChoices = { choices, fetchedAt: Date.now() };
    return choices;
  } catch {
    return FALLBACK_MODEL_CHOICES;
  }
}

/** A short human label for a model value (for confirmation messages). */
export function modelLabel(value: string | null | undefined): string {
  if (!value) return 'Default (inherit)';
  const known = [...(cachedChoices?.choices ?? []), ...FALLBACK_MODEL_CHOICES];
  const hit = known.find((m) => m.value === value);
  if (hit) return hit.label;
  // Derive a readable label from a raw id: 'claude-opus-5[1m]' -> 'opus 5'
  return value.replace(/^claude-/, '').replace(/\[1m\]$/, '').replace(/-/g, ' ');
}
