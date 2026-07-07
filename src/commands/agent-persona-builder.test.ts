import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildAgentPersonaText,
  _clearAgentPersonaCache,
} from './agent-persona-builder.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'persona-test-'));
  _clearAgentPersonaCache();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  _clearAgentPersonaCache();
});

describe('buildAgentPersonaText', () => {
  test('returns empty string when config is undefined', () => {
    expect(buildAgentPersonaText(undefined)).toBe('');
  });

  test('returns empty string when explicitly disabled', () => {
    expect(buildAgentPersonaText({ enabled: false })).toBe('');
  });

  test('returns empty string when configured paths do not exist', () => {
    expect(
      buildAgentPersonaText({
        soulPath: join(tmpRoot, 'missing-soul.md'),
        directivesPath: join(tmpRoot, 'missing-directives.md'),
        projectsIndexDir: join(tmpRoot, 'missing-projects'),
        // Brain is on by default and would contribute its section (that's
        // its job) — this test is about the file-based layers.
        brain: { enabled: false },
      }),
    ).toBe('');
  });

  test('reads directives + soul + projects index in that order', () => {
    const soulPath = join(tmpRoot, 'SOUL.md');
    const directivesPath = join(tmpRoot, 'DIRECTIVES.md');
    const projectsDir = join(tmpRoot, 'projects');

    writeFileSync(soulPath, '# SOUL\nI am a soul.\n');
    writeFileSync(directivesPath, '# DIRECTIVES\nFollow the rules.\n');
    mkdirSync(join(projectsDir, 'alpha'), { recursive: true });
    writeFileSync(join(projectsDir, 'alpha', 'description.md'), 'Alpha project — a thing.\n');

    const text = buildAgentPersonaText({
      soulPath,
      directivesPath,
      projectsIndexDir: projectsDir,
    });

    // Order matches Hermes: directives → soul → projects index
    const directivesIdx = text.indexOf('# DIRECTIVES');
    const soulIdx = text.indexOf('# SOUL');
    const projectsIdx = text.indexOf('Projects Index');
    expect(directivesIdx).toBeGreaterThanOrEqual(0);
    expect(soulIdx).toBeGreaterThan(directivesIdx);
    expect(projectsIdx).toBeGreaterThan(soulIdx);
    expect(text).toContain('- **alpha** — Alpha project — a thing.');
  });

  test('skips projects without description.md', () => {
    const projectsDir = join(tmpRoot, 'projects');
    mkdirSync(join(projectsDir, 'alpha'), { recursive: true });
    writeFileSync(join(projectsDir, 'alpha', 'description.md'), 'Alpha thing.\n');
    mkdirSync(join(projectsDir, 'beta'), { recursive: true });
    // beta has no description.md → skipped

    const text = buildAgentPersonaText({
      soulPath: join(tmpRoot, 'no-soul.md'),
      directivesPath: join(tmpRoot, 'no-directives.md'),
      projectsIndexDir: projectsDir,
    });
    expect(text).toContain('alpha');
    expect(text).not.toContain('beta');
  });

  test('returns empty when projects dir exists but has no projects with descriptions', () => {
    const projectsDir = join(tmpRoot, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(join(projectsDir, 'beta'), { recursive: true });
    // no description.md anywhere

    expect(
      buildAgentPersonaText({
        soulPath: join(tmpRoot, 'no-soul.md'),
        directivesPath: join(tmpRoot, 'no-directives.md'),
        projectsIndexDir: projectsDir,
        brain: { enabled: false },
      }),
    ).toBe('');
  });

  test('uses first non-empty line of description.md as the project hook', () => {
    const projectsDir = join(tmpRoot, 'projects');
    mkdirSync(join(projectsDir, 'alpha'), { recursive: true });
    writeFileSync(
      join(projectsDir, 'alpha', 'description.md'),
      '\n\n   \nFirst real line.\nSecond line should be ignored.\n',
    );

    const text = buildAgentPersonaText({
      soulPath: join(tmpRoot, 'no-soul.md'),
      directivesPath: join(tmpRoot, 'no-directives.md'),
      projectsIndexDir: projectsDir,
    });
    expect(text).toContain('- **alpha** — First real line.');
    expect(text).not.toContain('Second line should be ignored');
  });

  test('caches by mtime — same call twice returns identical text', () => {
    const soulPath = join(tmpRoot, 'SOUL.md');
    writeFileSync(soulPath, 'first content');
    const a = buildAgentPersonaText({
      soulPath,
      directivesPath: join(tmpRoot, 'no.md'),
      projectsIndexDir: join(tmpRoot, 'no'),
    });
    const b = buildAgentPersonaText({
      soulPath,
      directivesPath: join(tmpRoot, 'no.md'),
      projectsIndexDir: join(tmpRoot, 'no'),
    });
    expect(a).toBe(b);
    expect(a).toContain('first content');
  });
});
