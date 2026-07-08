/**
 * Profile-home resolver tests — OPENINTEL_HOME re-roots all bot state;
 * unset means the exact legacy locations.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { homedir } from 'os';
import {
  getProfileHome,
  getConfigDir,
  getStateDir,
  getAgentHome,
  getProfilesRoot,
} from './profile-home.js';

const ORIGINAL = process.env.OPENINTEL_HOME;

beforeEach(() => {
  delete process.env.OPENINTEL_HOME;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OPENINTEL_HOME;
  else process.env.OPENINTEL_HOME = ORIGINAL;
});

describe('legacy mode (OPENINTEL_HOME unset)', () => {
  test('resolves the exact pre-profile locations', () => {
    expect(getProfileHome()).toBeNull();
    expect(getConfigDir()).toBe(join(homedir(), '.config', 'claude-threads'));
    expect(getStateDir()).toBe(join(homedir(), '.claude-threads'));
    expect(getAgentHome()).toBe(join(homedir(), '.config', 'claude-threads', 'agent'));
  });

  test('empty / blank value counts as unset', () => {
    process.env.OPENINTEL_HOME = '   ';
    expect(getProfileHome()).toBeNull();
  });
});

describe('profile mode', () => {
  test('all state roots under the profile home', () => {
    process.env.OPENINTEL_HOME = '/tmp/openintel-test/natethropic';
    expect(getProfileHome()).toBe('/tmp/openintel-test/natethropic');
    expect(getConfigDir()).toBe('/tmp/openintel-test/natethropic');
    expect(getStateDir()).toBe('/tmp/openintel-test/natethropic');
    expect(getAgentHome()).toBe('/tmp/openintel-test/natethropic/agent');
  });

  test('tilde expands to the home directory', () => {
    process.env.OPENINTEL_HOME = '~/openintel/bot2';
    expect(getProfileHome()).toBe(join(homedir(), 'openintel', 'bot2'));
  });

  test('profiles root is ~/openintel', () => {
    expect(getProfilesRoot()).toBe(join(homedir(), 'openintel'));
  });
});

// =============================================================================
// Profile-first agent-file resolution (persona isolation between bots)
// =============================================================================

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import {
  resolveSoulPath,
  resolveDirectivesPath,
  resolveProjectsDir,
  resolveBrainDir,
} from './agent-paths.js';

describe('profile-first persona resolution', () => {
  let profile: string;

  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), 'oi-profile-'));
    process.env.OPENINTEL_HOME = profile;
  });

  afterEach(() => {
    rmSync(profile, { recursive: true, force: true });
    delete process.env.OPENINTEL_HOME;
  });

  test("a profile's own SOUL/DIRECTIVES/projects beat legacy machine-wide files", () => {
    // Regression: on a machine with ~/.hermes files, a fresh bot profile
    // inherited another bot's persona because legacy paths won the fallback.
    mkdirSync(join(profile, 'agent', 'projects'), { recursive: true });
    writeFileSync(join(profile, 'agent', 'SOUL.md'), '# bot2 soul');
    writeFileSync(join(profile, 'agent', 'DIRECTIVES.md'), '# bot2 rules');
    expect(resolveSoulPath(undefined)).toBe(join(profile, 'agent', 'SOUL.md'));
    expect(resolveDirectivesPath(undefined)).toBe(join(profile, 'agent', 'DIRECTIVES.md'));
    expect(resolveProjectsDir(undefined)).toBe(join(profile, 'agent', 'projects'));
  });

  test('explicit config paths still win over everything', () => {
    writeFileSync(join(profile, 'other-soul.md'), 'x');
    expect(resolveSoulPath({ soulPath: join(profile, 'other-soul.md') })).toBe(join(profile, 'other-soul.md'));
  });

  test('brain defaults inside the profile with no legacy fallback', () => {
    expect(resolveBrainDir(undefined)).toBe(join(profile, 'agent', 'brain'));
  });

  test('a FRESH profile (empty agent/) resolves inside itself — never to legacy files', () => {
    // Regression: with fallback-to-legacy, a brand-new bot on a machine with
    // ~/.hermes files started life as the other bot until given its own soul.
    expect(resolveSoulPath(undefined)).toBe(join(profile, 'agent', 'SOUL.md'));
    expect(resolveDirectivesPath(undefined)).toBe(join(profile, 'agent', 'DIRECTIVES.md'));
    expect(resolveProjectsDir(undefined)).toBe(join(profile, 'agent', 'projects'));
  });
});

describe('personaFromAgentDir (one-line per-bot shorthand)', () => {
  test('expands a base dir into full persona + skills paths', async () => {
    const { personaFromAgentDir } = await import('./agent-paths.js');
    const { agentPersona, skillsIndex } = personaFromAgentDir('/openintel/bots/bot2');
    expect(agentPersona.soulPath).toBe('/openintel/bots/bot2/SOUL.md');
    expect(agentPersona.directivesPath).toBe('/openintel/bots/bot2/DIRECTIVES.md');
    expect(agentPersona.projectsIndexDir).toBe('/openintel/bots/bot2/projects');
    expect(agentPersona.brain?.dir).toBe('/openintel/bots/bot2/brain');
    expect(skillsIndex.skillsDir).toBe('/openintel/bots/bot2/skills');
  });
});
