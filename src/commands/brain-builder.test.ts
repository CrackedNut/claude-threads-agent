/**
 * Second brain tests — scaffold bootstrap, prompt section, index inlining,
 * and the persona-layer integration.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildBrainText,
  ensureBrainScaffold,
  BRAIN_INDEX_FILENAME,
  _clearBrainCache,
} from './brain-builder.js';
import { buildAgentPersonaText, _clearAgentPersonaCache } from './agent-persona-builder.js';
import { resolveBrainDir } from '../config/agent-paths.js';

let tmpRoot: string;
let brainDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'brain-test-'));
  brainDir = join(tmpRoot, 'brain');
  _clearBrainCache();
  _clearAgentPersonaCache();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  _clearBrainCache();
  _clearAgentPersonaCache();
});

describe('resolveBrainDir', () => {
  test('explicit config dir wins (tilde-expanded)', () => {
    expect(resolveBrainDir({ brain: { dir: brainDir } })).toBe(brainDir);
  });

  test('defaults under the agent home', () => {
    expect(resolveBrainDir(undefined)).toContain(join('.config', 'claude-threads', 'agent', 'brain'));
  });
});

describe('ensureBrainScaffold', () => {
  test('creates the directory and INDEX.md template', () => {
    expect(ensureBrainScaffold(brainDir)).toBe(true);
    expect(existsSync(join(brainDir, BRAIN_INDEX_FILENAME))).toBe(true);
    expect(readFileSync(join(brainDir, BRAIN_INDEX_FILENAME), 'utf8')).toContain('Brain Index');
  });

  test('never overwrites an existing INDEX.md', () => {
    ensureBrainScaffold(brainDir);
    writeFileSync(join(brainDir, BRAIN_INDEX_FILENAME), '# Mine\n- [[note]] — kept');
    expect(ensureBrainScaffold(brainDir)).toBe(true);
    expect(readFileSync(join(brainDir, BRAIN_INDEX_FILENAME), 'utf8')).toContain('kept');
  });
});

describe('buildBrainText', () => {
  test('disabled → empty string, no scaffold', () => {
    expect(buildBrainText({ brain: { enabled: false, dir: brainDir } })).toBe('');
    expect(existsSync(brainDir)).toBe(false);
  });

  test('bootstraps and emits conventions with the absolute dir', () => {
    const text = buildBrainText({ brain: { dir: brainDir } });
    expect(text).toContain('## Second Brain');
    expect(text).toContain(brainDir);
    expect(text).toContain('[[wikilink]]');
    expect(existsSync(join(brainDir, BRAIN_INDEX_FILENAME))).toBe(true);
  });

  test('inlines the current INDEX.md content', () => {
    ensureBrainScaffold(brainDir);
    writeFileSync(
      join(brainDir, BRAIN_INDEX_FILENAME),
      '# Brain Index\n- [[fifa-bot]] — ticketing automation notes',
    );
    const text = buildBrainText({ brain: { dir: brainDir } });
    expect(text).toContain('[[fifa-bot]] — ticketing automation notes');
  });

  test('index edits surface without a restart (mtime cache)', async () => {
    ensureBrainScaffold(brainDir);
    writeFileSync(join(brainDir, BRAIN_INDEX_FILENAME), '- [[first]] — v1');
    expect(buildBrainText({ brain: { dir: brainDir } })).toContain('[[first]]');
    // mtimeMs can collide within the same ms on fast writes; nudge the clock.
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(join(brainDir, BRAIN_INDEX_FILENAME), '- [[second]] — v2');
    expect(buildBrainText({ brain: { dir: brainDir } })).toContain('[[second]]');
  });
});

describe('persona-layer integration', () => {
  test('brain section rides buildAgentPersonaText by default', () => {
    const text = buildAgentPersonaText({ brain: { dir: brainDir } });
    expect(text).toContain('## Second Brain');
  });

  test('agentPersona.enabled: false kills the brain too', () => {
    expect(buildAgentPersonaText({ enabled: false, brain: { dir: brainDir } })).toBe('');
    expect(existsSync(brainDir)).toBe(false);
  });
});

describe('brain conventions (v2.2.8)', () => {
  test('teaches no-duplication, source citation, and brain-over-session-memory', () => {
    const text = buildBrainText({ brain: { dir: brainDir } });
    expect(text).toContain('NEVER duplicate');
    expect(text).toContain('read_archive');
    expect(text).toContain('session-local memory directory');
  });
});
