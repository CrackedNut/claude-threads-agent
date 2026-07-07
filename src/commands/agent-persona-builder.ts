/**
 * Agent Persona Builder — Hermes-style "Tier 1 stable" content.
 *
 * Reads up to three optional file-based layers and concatenates them into
 * a single string that gets prepended to Claude's `--append-system-prompt`:
 *
 *   1. DIRECTIVES.md — immutable behavioral loops (read-only guardrails).
 *   2. SOUL.md       — persona / identity / tone.
 *   3. Projects index — one-line summary per project, auto-built from
 *      `<projectsIndexDir>/<project>/description.md` files.
 *
 * All layers are optional. Missing files are silently skipped — the Hermes
 * defaults (`~/.hermes/SOUL.md`, `~/.hermes/DIRECTIVES.md`,
 * `~/agent-memory/projects/`) are only present on machines with a Hermes
 * install, so it's normal for them to be absent.
 *
 * Reads are synchronous + cached on the file path. The cache is keyed by
 * absolute path + mtime so manual edits to SOUL.md surface on the next
 * session spawn without a bot restart.
 *
 * The output is stable for the lifetime of the underlying files, so callers
 * can pass it straight to `buildAppendSystemPrompt` — it lives in the
 * "stable" layer of the appended prompt, before the session context line,
 * to maximize prefix-cache hits on the upstream API.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { AgentPersonaConfig } from '../config/types.js';
import { createLogger } from '../utils/logger.js';
import { resolveSoulPath, resolveDirectivesPath, resolveProjectsDir } from '../config/agent-paths.js';
import { buildBrainText } from './brain-builder.js';

const log = createLogger('agent-persona');

interface CacheEntry {
  mtimeMs: number;
  content: string;
}
const fileCache = new Map<string, CacheEntry>();

function readFileCached(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    const cached = fileCache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content;
    const content = readFileSync(path, 'utf8').trim();
    fileCache.set(path, { mtimeMs: stat.mtimeMs, content });
    return content;
  } catch (err) {
    log.debug(`Failed to read ${path}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Build the projects index by scanning subdirs of `dir` for `description.md`
 * files. Each project produces one bullet:
 *
 *   - **project-name** — first non-empty line of description.md
 *
 * Returns null when the dir doesn't exist or contains no projects.
 */
function buildProjectsIndex(dir: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
    const lines: string[] = [];
    for (const name of entries) {
      const descPath = join(dir, name, 'description.md');
      const content = readFileCached(descPath);
      if (!content) continue;
      const firstLine = content.split('\n').find(l => l.trim().length > 0)?.trim();
      if (!firstLine) continue;
      lines.push(`- **${name}** — ${firstLine}`);
    }
    if (lines.length === 0) return null;
    return `## Projects Index\n\nProjects tracked in agent memory (one-line summary per project):\n\n${lines.join('\n')}`;
  } catch (err) {
    log.debug(`Failed to build projects index from ${dir}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Assemble the persona text. Returns an empty string when the feature is
 * disabled or every layer is missing — callers can treat the result as
 * "prepend if non-empty".
 *
 * Layer order matches Hermes' system_prompt.py: directives first (immutable
 * loops), then soul (identity), then projects index, then the second brain
 * (conventions + inlined INDEX.md). Joined with `\n\n`.
 *
 * Note: the persona layer stays opt-in (an `agentPersona:` block must exist
 * in config.yaml, as before). When present, the brain is ON by default and
 * rides this layer to reach every spawn site without per-site wiring;
 * `agentPersona.brain.enabled: false` disables just the brain,
 * `agentPersona.enabled: false` disables all layers including it.
 */
export function buildAgentPersonaText(config?: AgentPersonaConfig): string {
  if (!config || config.enabled === false) return '';

  // Shared resolution (config → legacy locations → claude-threads agent
  // home) — keeps the dashboard's Paths tab and the actual session prompt
  // in agreement. See src/config/agent-paths.ts.
  const soulPath = resolveSoulPath(config);
  const directivesPath = resolveDirectivesPath(config);
  const projectsDir = resolveProjectsDir(config);

  const parts: string[] = [];

  const directives = readFileCached(directivesPath);
  if (directives) parts.push(directives);

  const soul = readFileCached(soulPath);
  if (soul) parts.push(soul);

  const projectsIndex = buildProjectsIndex(projectsDir);
  if (projectsIndex) parts.push(projectsIndex);

  const brainText = buildBrainText(config);
  if (brainText) parts.push(brainText);

  return parts.join('\n\n');
}

/** Clear the file cache. Exposed for tests; not used at runtime. */
export function _clearAgentPersonaCache(): void {
  fileCache.clear();
}
