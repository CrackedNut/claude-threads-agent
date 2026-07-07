/**
 * Agent content paths — single source of truth for where the persona
 * (SOUL.md / DIRECTIVES.md), projects index, and skills library live.
 *
 * Resolution order, per path:
 *   1. Explicit config (`agentPersona.*`, `skillsIndex.skillsDir`) — set via
 *      config.yaml or the dashboard's Paths tab.
 *   2. Legacy locations if they exist (Hermes `~/.hermes/*`,
 *      `~/agent-memory/projects`, `~/.claude/skills`) — keeps machines that
 *      predate claude-threads owning this content working unchanged.
 *   3. The claude-threads agent home: `~/.config/claude-threads/agent/` —
 *      what fresh installs get, so new machines never depend on Hermes.
 *
 * Used by the persona/skills system-prompt builders AND the dashboard, so
 * what the panel edits is always what sessions actually load.
 */

import { existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { AgentPersonaConfig, SkillsIndexConfig, Config } from './types.js';

/** Self-owned content root for fresh installs. */
export const AGENT_HOME = join(homedir(), '.config', 'claude-threads', 'agent');

/**
 * Expand a leading `~` to the user's home dir, otherwise resolve to an
 * absolute path. Exported so the session working-directory resolver can
 * honor `~`-prefixed `workingDir` values from config.yaml.
 */
export function resolveTilde(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : resolve(p);
}

/**
 * Resolve the default session working directory. Prefers the configured
 * `workingDir` (tilde-expanded), falling back to the bot's own launch cwd.
 * Without the config preference the daemon's cwd — the source checkout,
 * e.g. ~/code/claude-threads-agent — leaks in as every session's default.
 */
export function resolveSessionWorkingDir(
  configWorkingDir: string | undefined,
  cwd: string,
): string {
  return configWorkingDir ? resolveTilde(configWorkingDir) : cwd;
}

function firstExisting(candidates: string[], fallback: string): string {
  for (const c of candidates) if (existsSync(c)) return c;
  return fallback;
}

export function resolveSoulPath(config?: AgentPersonaConfig): string {
  if (config?.soulPath) return resolveTilde(config.soulPath);
  return firstExisting([join(homedir(), '.hermes', 'SOUL.md')], join(AGENT_HOME, 'SOUL.md'));
}

export function resolveDirectivesPath(config?: AgentPersonaConfig): string {
  if (config?.directivesPath) return resolveTilde(config.directivesPath);
  return firstExisting([join(homedir(), '.hermes', 'DIRECTIVES.md')], join(AGENT_HOME, 'DIRECTIVES.md'));
}

export function resolveProjectsDir(config?: AgentPersonaConfig): string {
  if (config?.projectsIndexDir) return resolveTilde(config.projectsIndexDir);
  return firstExisting([join(homedir(), 'agent-memory', 'projects')], join(AGENT_HOME, 'projects'));
}

export function resolveBrainDir(config?: AgentPersonaConfig): string {
  if (config?.brain?.dir) return resolveTilde(config.brain.dir);
  return join(AGENT_HOME, 'brain');
}

/** A skills dir only counts if it actually contains at least one SKILL.md. */
function hasAnySkill(dir: string): boolean {
  return existsSync(dir) && findSkillEntries(dir).length > 0;
}

export function resolveSkillsDir(config?: SkillsIndexConfig): string {
  if (config?.skillsDir) return resolveTilde(config.skillsDir);
  for (const cand of [join(homedir(), '.claude', 'skills'), join(homedir(), '.hermes', 'skills')]) {
    if (hasAnySkill(cand)) return cand;
  }
  return join(AGENT_HOME, 'skills');
}

export interface AgentPaths {
  soul: string;
  directives: string;
  projectsDir: string;
  skillsDir: string;
  brainDir: string;
}

export function resolveAgentPaths(config?: Config | null): AgentPaths {
  return {
    soul: resolveSoulPath(config?.agentPersona),
    directives: resolveDirectivesPath(config?.agentPersona),
    projectsDir: resolveProjectsDir(config?.agentPersona),
    skillsDir: resolveSkillsDir(config?.skillsIndex),
    brainDir: resolveBrainDir(config?.agentPersona),
  };
}

/**
 * Find skills under a skills dir. Supports both layouts:
 *   <dir>/<skill>/SKILL.md             → name "skill"
 *   <dir>/<category>/<skill>/SKILL.md  → name "category/skill"
 * Sorted by name.
 */
export function findSkillEntries(skillsDir: string): Array<{ name: string; mdPath: string }> {
  if (!existsSync(skillsDir)) return [];
  const out: Array<{ name: string; mdPath: string }> = [];
  let top: import('fs').Dirent[];
  try {
    top = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  for (const entry of top) {
    const direct = join(skillsDir, entry.name, 'SKILL.md');
    if (existsSync(direct)) {
      out.push({ name: entry.name, mdPath: direct });
      continue;
    }
    // Category dir: one more level
    try {
      for (const sub of readdirSync(join(skillsDir, entry.name), { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const nested = join(skillsDir, entry.name, sub.name, 'SKILL.md');
        if (existsSync(nested)) out.push({ name: `${entry.name}/${sub.name}`, mdPath: nested });
      }
    } catch {
      // unreadable category dir — skip
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
