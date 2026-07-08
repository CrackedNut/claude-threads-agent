/**
 * Second brain — persistent, Obsidian-compatible markdown memory.
 *
 * A directory of one-topic-per-note markdown files linked with
 * `[[wikilinks]]`, mapped by an `INDEX.md` that is inlined into every
 * session's system prompt. The agent reads notes with its normal file tools
 * (they're just files on disk) and is instructed to update them whenever it
 * finishes meaningful work — so knowledge accumulates across sessions,
 * channels, and restarts.
 *
 * Obsidian compatibility is deliberate: point `agentPersona.brain.dir` at a
 * vault folder and the user gets the graph view over the agent's memory for
 * free. Nothing here depends on Obsidian.
 *
 * The prompt section rides the persona layer (`buildAgentPersonaText`), so
 * it reaches every spawn site — session start, `!cd` respawns, worktree
 * switches, resume — without per-call-site wiring. Enabled by default;
 * `agentPersona.brain.enabled: false` turns it off.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentPersonaConfig } from '../config/types.js';
import { resolveBrainDir } from '../config/agent-paths.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('brain');

export const BRAIN_INDEX_FILENAME = 'INDEX.md';

const INDEX_TEMPLATE = `# Brain Index

<!--
One line per note: "- [[note-name]] — what it holds."
The agent keeps this file current. Notes live alongside it as <note-name>.md.
Keep this index small — content belongs in the notes, never here.
-->
`;

interface CacheEntry {
  mtimeMs: number;
  content: string;
}
const indexCache = new Map<string, CacheEntry>();

/**
 * Create the brain directory + INDEX.md template if missing. Idempotent and
 * failure-tolerant: a read-only disk should never break session spawning.
 * Returns true when the scaffold exists (pre-existing or just created).
 */
export function ensureBrainScaffold(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const indexPath = join(dir, BRAIN_INDEX_FILENAME);
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, INDEX_TEMPLATE, { flag: 'wx' });
      log.info(`Bootstrapped second brain at ${dir}`);
    }
    return true;
  } catch (err) {
    log.warn(`Could not scaffold brain dir ${dir}: ${(err as Error).message}`);
    return false;
  }
}

function readIndexCached(indexPath: string): string | null {
  if (!existsSync(indexPath)) return null;
  try {
    const stat = statSync(indexPath);
    const cached = indexCache.get(indexPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content;
    const content = readFileSync(indexPath, 'utf8').trim();
    indexCache.set(indexPath, { mtimeMs: stat.mtimeMs, content });
    return content;
  } catch (err) {
    log.debug(`Failed to read ${indexPath}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Build the "Second Brain" system-prompt section: conventions + the inlined
 * INDEX.md. Returns '' when disabled or the scaffold can't be created.
 */
export function buildBrainText(config?: AgentPersonaConfig): string {
  if (config?.brain?.enabled === false) return '';

  const dir = resolveBrainDir(config);
  if (!ensureBrainScaffold(dir)) return '';

  const index = readIndexCached(join(dir, BRAIN_INDEX_FILENAME));

  return `## Second Brain

You have a persistent markdown knowledge base (your "second brain") at:
\`${dir}\`
It survives across all sessions, channels, and restarts. Read and write it with your normal file tools — the notes are plain files on disk.

Conventions:
- \`INDEX.md\` (inlined below) is the map. When a task touches a topic listed there, READ that note before working. A \`[[wikilink]]\` named \`some-note\` lives at \`${dir}/some-note.md\` — follow links as deep as relevance demands.
- One topic per note, kebab-case filename. Link related notes with \`[[name]]\` liberally; a link to a note that doesn't exist yet marks it as worth writing.
- When you finish meaningful work or learn something durable — a decision, a gotcha, a project fact, a user preference — UPDATE the brain before ending the turn: edit the relevant note or create a new one, and keep its one-line entry in INDEX.md current (\`- [[note-name]] — hook\`).
- Keep INDEX.md small: one line per note, details in the notes, never content in the index.
- Notes are point-in-time observations. Verify claims that may have gone stale (file paths, versions, running services) before relying on them.
- NEVER duplicate what a repo, its CLAUDE.md, or a skill already records — write a one-line pointer to it instead. Copies go stale the moment the source moves; the brain holds what is written down nowhere else.
- Cite your sources: when a note distills from a chat, include the session id (e.g. \`source: session a1b2c3d4\`) so \`read_archive\` can replay the receipts later.
- The brain is your ONE home for durable knowledge. Do not save durable facts to the session-local memory directory (it is keyed to the working directory and invisible to conversations running anywhere else) — brain instead.

### INDEX.md (current)
${index && index.length > 0 ? index : '(empty — no notes yet)'}`;
}

/** Clear the index cache. Exposed for tests; not used at runtime. */
export function _clearBrainCache(): void {
  indexCache.clear();
}
