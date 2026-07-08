/**
 * Profile homes — one directory that owns everything a bot is.
 *
 * When `OPENINTEL_HOME` is set (the manager script exports it per profile,
 * e.g. `~/openintel/natethropic`), ALL bot state roots under it:
 *
 *   <home>/config.yaml          bot config (platforms, tokens, panel port)
 *   <home>/sessions.json        session persistence
 *   <home>/update-state.json    auto-update state
 *   <home>/github-emails.json   collaborator emails
 *   <home>/agent/               SOUL.md, DIRECTIVES.md, projects/, skills/, brain/
 *   <home>/logs/                bot.log + thread-log archive (chat memory)
 *   <home>/worktrees/ + worktree-metadata.json
 *
 * Unset → the exact legacy locations (~/.config/claude-threads + ~/.claude-threads),
 * byte-for-byte, so existing single-bot installs behave identically. This is
 * what makes multiple bots on one machine possible: each daemon starts with
 * its own OPENINTEL_HOME and never touches another's state.
 *
 * The resolvers read the env var lazily so tests can vary it; in production
 * the manager script sets it before the process starts, so module-level
 * constants derived from these calls are stable and correct.
 */

import { join, resolve } from 'path';
import { homedir } from 'os';

/** Default root for named profiles: `openintel start <name>` → ~/openintel/<name>. */
export function getProfilesRoot(): string {
  return join(homedir(), 'openintel');
}

/** The active profile home, or null when running on legacy paths. */
export function getProfileHome(): string | null {
  const raw = process.env.OPENINTEL_HOME?.trim();
  if (!raw) return null;
  return raw.startsWith('~') ? join(homedir(), raw.slice(1)) : resolve(raw);
}

/** config.yaml, sessions.json, update-state.json, github-emails.json. */
export function getConfigDir(): string {
  return getProfileHome() ?? join(homedir(), '.config', 'claude-threads');
}

/** logs/, worktrees/, worktree-metadata.json. */
export function getStateDir(): string {
  return getProfileHome() ?? join(homedir(), '.claude-threads');
}

/** Default root for agent content (SOUL/DIRECTIVES/projects/skills/brain). */
export function getAgentHome(): string {
  const home = getProfileHome();
  return home ? join(home, 'agent') : join(homedir(), '.config', 'claude-threads', 'agent');
}
