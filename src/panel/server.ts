/**
 * Agent Dashboard — local web panel.
 *
 * Runs inside the bot process, bound to 127.0.0.1 by default (override with
 * `panel.host`). Lets the operator:
 *   - see bot status (version, platforms, active sessions)
 *   - edit config.yaml (platforms, tokens, modes) and restart to apply
 *   - edit the agent persona files (SOUL.md / DIRECTIVES.md)
 *   - manage the projects index (<projectsIndexDir>/<name>/description.md)
 *   - manage skills (flat <skill>/SKILL.md or nested <category>/<skill>/SKILL.md)
 *   - change where soul/directives/projects/skills live (Paths tab —
 *     persisted into config.yaml via the shared agent-paths resolution)
 *   - restart the bot (exit 42 → daemon restarts it; sessions resume)
 *
 * SECURITY MODEL: single-operator tool with NO auth — anything that can reach
 * it can edit your config/persona and restart the bot. Bound to 127.0.0.1 by
 * default, where "can reach it" == "already has your shell". `panel.host` can
 * widen the bind (e.g. `0.0.0.0` for Tailscale/LAN access); only do so on a
 * trusted network, since there's still no authentication.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { execSync, spawn } from 'child_process';
import { CONFIG_PATH, loadConfigWithMigration, saveConfig } from '../config/index.js';
import { resolveAgentPaths, findSkillEntries } from '../config/agent-paths.js';
import { PANEL_HTML } from './ui.js';
import { getStateDir } from '../config/profile-home.js';

const BOT_LOG = join(getStateDir(), 'logs', 'bot.log');

/** One safe path segment (no traversal, no separators). */
function isSafeSegment(seg: string): boolean {
  return /^[\w][\w.-]{0,127}$/.test(seg);
}

/** Skill names may be "name" or "category/name"; each segment must be safe. */
function isSafeSkillName(name: string): boolean {
  const parts = name.split('/');
  return parts.length >= 1 && parts.length <= 2 && parts.every(isSafeSegment);
}

export interface PanelStatusProvider {
  version: string;
  getSessions(): Array<{
    sessionId: string;
    platformId: string;
    mode: string;
    title?: string;
    startedBy: string;
    startedAt: string;
    isProcessing: boolean;
    workingDir?: string;
    model?: string;
    contextTokens?: number;
    contextWindowSize?: number;
    totalCostUSD?: number;
    recentEvents?: Array<{ type: string; timestamp: number; summary: string }>;
  }>;
  getPlatforms(): Array<{ id: string; type: string; displayName: string; connected: boolean }>;
  /** Stop (kill) a session by sessionId. */
  stopSession(sessionId: string): Promise<boolean>;
  /** Interrupt (escape) a session by sessionId without killing it. */
  interruptSession(sessionId: string): Promise<boolean>;
}

/** Git info for the running checkout — resolved once, best-effort. */
function gitInfo(): { branch: string; sha: string } {
  try {
    const repoRoot = resolve(dirname(process.argv[1] ?? '.'), '..');
    const opts = { cwd: repoRoot, encoding: 'utf-8' as const, timeout: 3000 };
    return {
      branch: execSync('git rev-parse --abbrev-ref HEAD', opts).trim(),
      sha: execSync('git rev-parse --short HEAD', opts).trim(),
    };
  } catch {
    return { branch: 'unknown', sha: 'unknown' };
  }
}

export interface PanelOptions {
  port?: number;
  /**
   * Bind address. Default `127.0.0.1` (loopback only). `0.0.0.0` binds all
   * interfaces (reachable over Tailscale/LAN). The panel has no auth — only
   * widen this on a trusted network. See the SECURITY MODEL note above.
   */
  host?: string;
  status: PanelStatusProvider;
  /** Graceful restart: persist + disconnect, then exit(42) for the daemon. */
  requestRestart: () => Promise<void>;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

function readTextOr(path: string, fallback = ''): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : fallback;
  } catch {
    return fallback;
  }
}

/** One safe markdown filename (no traversal, must end .md). */
function isSafeMdFile(name: string): boolean {
  return /^[\w][\w.-]{0,127}\.md$/i.test(name) && !name.includes('..');
}

/** All .md files in a project dir, description.md first. */
function listProjectFiles(projectDir: string): string[] {
  try {
    const files = readdirSync(projectDir).filter((f) => isSafeMdFile(f)).sort();
    const i = files.indexOf('description.md');
    if (i > 0) {
      files.splice(i, 1);
      files.unshift('description.md');
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * List <dir>/<name>/ entries: description.md content (for list subtitles)
 * plus every markdown file in the project dir for per-file editing.
 */
function listProjectEntries(dir: string): Array<{ name: string; content: string; files: string[] }> {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isSafeSegment(e.name))
      .map((e) => ({
        name: e.name,
        content: readTextOr(join(dir, e.name, 'description.md')),
        files: listProjectFiles(join(dir, e.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function startPanelServer(options: PanelOptions): { port: number; close: () => void } {
  const port = options.port ?? 7777;
  const app = new Hono();

  app.get('/', (c) => c.html(PANEL_HTML));

  const git = gitInfo();

  // ---- status -------------------------------------------------------------
  app.get('/api/status', (c) => {
    const config = loadConfigWithMigration();
    return c.json({
      version: options.status.version,
      git,
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      configPath: CONFIG_PATH,
      paths: resolveAgentPaths(config),
      platforms: options.status.getPlatforms(),
      sessions: options.status.getSessions(),
    });
  });

  // ---- logs (written by the manager script's start_bot redirect) ----------
  app.get('/api/logs', (c) => {
    const lines = Math.min(parseInt(c.req.query('lines') ?? '300', 10) || 300, 2000);
    const text = readTextOr(BOT_LOG);
    const all = text.split('\n');
    return c.json({ path: BOT_LOG, lines: all.slice(-lines) });
  });

  // ---- session controls ----------------------------------------------------
  app.post('/api/sessions/:id{.+}/stop', async (c) => {
    const ok = await options.status.stopSession(c.req.param('id'));
    options.log('info', `panel: stop session ${c.req.param('id')} → ${ok ? 'ok' : 'not found'}`);
    return c.json({ ok });
  });
  app.post('/api/sessions/:id{.+}/interrupt', async (c) => {
    const ok = await options.status.interruptSession(c.req.param('id'));
    options.log('info', `panel: interrupt session ${c.req.param('id')} → ${ok ? 'ok' : 'not found'}`);
    return c.json({ ok });
  });

  // ---- one-click update -----------------------------------------------------
  // Hands off to the manager script (detached — it survives this process
  // being stopped): snapshot, fetch, checkout, build, restart.
  app.post('/api/update', (c) => {
    const manager = [
      join(homedir(), 'bin', 'claude-threads'),
      resolve(dirname(process.argv[1] ?? '.'), '..', 'scripts', 'claude-threads-install.sh'),
    ].find(existsSync);
    if (!manager) return c.json({ ok: false, error: 'manager script not found' }, 500);
    options.log('info', `panel: update requested → ${manager} install ${git.branch}`);
    const child = spawn('bash', [manager, 'install', git.branch], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    return c.json({ ok: true, note: 'updating — bot rebuilds and restarts, back in ~1-2 min' });
  });

  // ---- config.yaml (raw text — YAML comments survive round-trips) ---------
  app.get('/api/config', (c) => c.text(readTextOr(CONFIG_PATH)));
  app.put('/api/config', async (c) => {
    const body = await c.req.text();
    try {
      const yaml = await import('js-yaml');
      const parsed = yaml.load(body) as { platforms?: unknown[] } | null;
      // Empty `platforms: []` is allowed (setup mode); a non-array is not.
      if (!parsed || (parsed.platforms !== undefined && !Array.isArray(parsed.platforms))) {
        return c.json({ ok: false, error: '`platforms:` must be a list (it may be empty)' }, 400);
      }
    } catch (err) {
      return c.json({ ok: false, error: `invalid YAML: ${err instanceof Error ? err.message : err}` }, 400);
    }
    writeFileSync(CONFIG_PATH, body, { mode: 0o600 });
    options.log('info', 'panel: config.yaml saved (restart to apply)');
    return c.json({ ok: true, note: 'saved — restart the bot to apply' });
  });

  // ---- paths (persisted into config.yaml) ----------------------------------
  app.get('/api/paths', (c) => {
    const config = loadConfigWithMigration();
    return c.json({
      resolved: resolveAgentPaths(config),
      configured: {
        soulPath: config?.agentPersona?.soulPath ?? null,
        directivesPath: config?.agentPersona?.directivesPath ?? null,
        projectsIndexDir: config?.agentPersona?.projectsIndexDir ?? null,
        skillsDir: config?.skillsIndex?.skillsDir ?? null,
      },
    });
  });
  app.put('/api/paths', async (c) => {
    const config = loadConfigWithMigration();
    if (!config) return c.json({ ok: false, error: 'no config to update' }, 400);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'expected JSON body' }, 400);
    }
    const pick = (key: string): string | undefined => {
      const v = body[key];
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    };
    config.agentPersona = {
      ...config.agentPersona,
      soulPath: pick('soulPath'),
      directivesPath: pick('directivesPath'),
      projectsIndexDir: pick('projectsIndexDir'),
    };
    config.skillsIndex = { ...config.skillsIndex, skillsDir: pick('skillsDir') };
    // NOTE: saveConfig() re-serializes the YAML, so hand-written comments in
    // config.yaml are dropped. The Config tab edits raw text when that matters.
    saveConfig(config);
    options.log('info', 'panel: agent paths updated in config.yaml');
    return c.json({ ok: true, resolved: resolveAgentPaths(config) });
  });

  // ---- persona files -------------------------------------------------------
  for (const key of ['soul', 'directives'] as const) {
    app.get(`/api/persona/${key}`, (c) => {
      const paths = resolveAgentPaths(loadConfigWithMigration());
      return c.json({ path: paths[key], content: readTextOr(paths[key]) });
    });
    app.put(`/api/persona/${key}`, async (c) => {
      const paths = resolveAgentPaths(loadConfigWithMigration());
      const content = await c.req.text();
      mkdirSync(resolve(paths[key], '..'), { recursive: true });
      writeFileSync(paths[key], content);
      options.log('info', `panel: ${key} saved → ${paths[key]} (picked up on next session start)`);
      return c.json({ ok: true });
    });
  }

  // ---- projects index ------------------------------------------------------
  app.get('/api/projects', (c) => {
    const { projectsDir } = resolveAgentPaths(loadConfigWithMigration());
    return c.json({ dir: projectsDir, entries: listProjectEntries(projectsDir) });
  });
  app.put('/api/projects/:name', async (c) => {
    const name = c.req.param('name');
    if (!isSafeSegment(name)) return c.json({ ok: false, error: 'invalid project name' }, 400);
    const { projectsDir } = resolveAgentPaths(loadConfigWithMigration());
    const dir = join(projectsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'description.md'), await c.req.text());
    options.log('info', `panel: project "${name}" saved`);
    return c.json({ ok: true });
  });
  app.delete('/api/projects/:name', (c) => {
    const name = c.req.param('name');
    if (!isSafeSegment(name)) return c.json({ ok: false, error: 'invalid project name' }, 400);
    const { projectsDir } = resolveAgentPaths(loadConfigWithMigration());
    const target = join(projectsDir, name, 'description.md');
    if (existsSync(target)) rmSync(target);
    options.log('info', `panel: project "${name}" description removed`);
    return c.json({ ok: true });
  });

  // ---- per-file project markdown (notes, playbooks, status, …) -------------
  app.get('/api/projects/:name/files/:file', (c) => {
    const { name, file } = c.req.param();
    if (!isSafeSegment(name) || !isSafeMdFile(file)) return c.json({ ok: false, error: 'invalid name' }, 400);
    const { projectsDir } = resolveAgentPaths(loadConfigWithMigration());
    return c.json({ content: readTextOr(join(projectsDir, name, file)) });
  });
  app.put('/api/projects/:name/files/:file', async (c) => {
    const { name, file } = c.req.param();
    if (!isSafeSegment(name) || !isSafeMdFile(file)) return c.json({ ok: false, error: 'invalid name' }, 400);
    const { projectsDir } = resolveAgentPaths(loadConfigWithMigration());
    const dir = join(projectsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), await c.req.text());
    options.log('info', `panel: project file "${name}/${file}" saved`);
    return c.json({ ok: true });
  });
  app.delete('/api/projects/:name/files/:file', (c) => {
    const { name, file } = c.req.param();
    if (!isSafeSegment(name) || !isSafeMdFile(file)) return c.json({ ok: false, error: 'invalid name' }, 400);
    const { projectsDir } = resolveAgentPaths(loadConfigWithMigration());
    const target = join(projectsDir, name, file);
    if (existsSync(target)) rmSync(target);
    options.log('info', `panel: project file "${name}/${file}" deleted`);
    return c.json({ ok: true });
  });

  // ---- skills (supports "name" and "category/name") -------------------------
  app.get('/api/skills', (c) => {
    const { skillsDir } = resolveAgentPaths(loadConfigWithMigration());
    const entries = findSkillEntries(skillsDir).map((e) => ({
      name: e.name,
      content: readTextOr(e.mdPath),
    }));
    return c.json({ dir: skillsDir, entries });
  });
  app.put('/api/skills/:name{.+}', async (c) => {
    const name = c.req.param('name');
    if (!isSafeSkillName(name)) return c.json({ ok: false, error: 'invalid skill name' }, 400);
    const { skillsDir } = resolveAgentPaths(loadConfigWithMigration());
    const mdPath = join(skillsDir, name, 'SKILL.md');
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, await c.req.text());
    options.log('info', `panel: skill "${name}" saved`);
    return c.json({ ok: true });
  });
  app.delete('/api/skills/:name{.+}', (c) => {
    const name = c.req.param('name');
    if (!isSafeSkillName(name)) return c.json({ ok: false, error: 'invalid skill name' }, 400);
    const { skillsDir } = resolveAgentPaths(loadConfigWithMigration());
    const target = join(skillsDir, name, 'SKILL.md');
    if (existsSync(target)) rmSync(target);
    options.log('info', `panel: skill "${name}" removed`);
    return c.json({ ok: true });
  });

  // ---- platforms (UI-based setup, no terminal wizard needed) ----------------
  app.get('/api/platforms', (c) => {
    const config = loadConfigWithMigration();
    const mask = (t?: string) => (t ? t.slice(0, 4) + '…' + t.slice(-4) : '');
    const entries = (config?.platforms ?? []).map((p) => {
      const x = p as Record<string, string | undefined>;
      return {
        id: x.id,
        type: x.type,
        displayName: x.displayName,
        botName: x.botName,
        channelId: x.channelId,
        url: x.url,
        token: mask(x.token ?? x.botToken),
      };
    });
    return c.json({ entries });
  });

  app.post('/api/platforms', async (c) => {
    let body: Record<string, string>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'expected JSON body' }, 400);
    }
    const type = body.type;
    const required =
      type === 'mattermost'
        ? ['url', 'token', 'channelId', 'botName']
        : type === 'slack'
          ? ['botToken', 'appToken', 'channelId', 'botName']
          : type === 'discord'
            ? ['token', 'channelId', 'botName']
            : null;
    if (!required) return c.json({ ok: false, error: 'type must be "mattermost", "slack", or "discord"' }, 400);
    for (const k of required) {
      if (!body[k]?.trim()) return c.json({ ok: false, error: `missing field: ${k}` }, 400);
    }

    // Validate credentials with real API calls before touching the config.
    const { validateMattermostCredentials, validateSlackCredentials, validateDiscordCredentials } =
      await import('../onboarding.js');
    const url = (body.url ?? '').replace(/\/+$/, '');
    const result =
      type === 'mattermost'
        ? await validateMattermostCredentials(url, body.token, body.channelId)
        : type === 'discord'
          ? await validateDiscordCredentials(body.token, body.channelId)
          : await validateSlackCredentials(body.botToken, body.appToken, body.channelId);
    if (!result.success) return c.json({ ok: false, error: result.error ?? 'credential validation failed' }, 400);

    const config = loadConfigWithMigration();
    if (!config) return c.json({ ok: false, error: 'no config to update' }, 400);
    config.platforms = config.platforms ?? [];

    const id = (body.id?.trim() || `${type}-${body.botName}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (config.platforms.some((p) => (p as { id?: string }).id === id)) {
      return c.json({ ok: false, error: `platform id "${id}" already exists` }, 400);
    }
    const allowedUsers = (body.allowedUsers ?? '')
      .split(/[,\s]+/)
      .map((u) => u.replace(/^@/, '').trim())
      .filter(Boolean);

    const entry: Record<string, unknown> = {
      id,
      type,
      displayName: body.displayName?.trim() || result.teamName || id,
      channelId: body.channelId.trim(),
      botName: result.botUsername || body.botName.trim(),
      allowedUsers,
      skipPermissions: false,
      sessionHeader: 'hidden',
      stickyMessage: 'hidden',
    };
    if (type === 'mattermost') {
      entry.url = url;
      entry.token = body.token.trim();
    } else if (type === 'discord') {
      entry.token = body.token.trim();
      entry.allChannels = body.allChannels === 'true' || body.allChannels === '1';
    } else {
      entry.botToken = body.botToken.trim();
      entry.appToken = body.appToken.trim();
    }
    config.platforms.push(entry as (typeof config.platforms)[number]);
    saveConfig(config);
    options.log('info', `panel: platform "${id}" added (${type}) — restart to connect`);
    return c.json({
      ok: true,
      id,
      validated: { botUsername: result.botUsername, channelName: result.channelName, teamName: result.teamName },
      note: 'saved — restart the bot to connect',
    });
  });

  app.delete('/api/platforms/:id', (c) => {
    const id = c.req.param('id');
    const config = loadConfigWithMigration();
    if (!config) return c.json({ ok: false, error: 'no config' }, 400);
    const before = config.platforms?.length ?? 0;
    config.platforms = (config.platforms ?? []).filter((p) => (p as { id?: string }).id !== id);
    if (config.platforms.length === before) return c.json({ ok: false, error: 'no such platform' }, 404);
    saveConfig(config);
    options.log('info', `panel: platform "${id}" removed — restart to apply`);
    return c.json({ ok: true });
  });

  // ---- restart ----------------------------------------------------------------
  app.post('/api/restart', (c) => {
    options.log('info', 'panel: restart requested');
    // Respond first, then restart — the daemon brings the bot (and panel) back.
    setTimeout(() => {
      options.requestRestart().catch((err) => options.log('error', `panel restart failed: ${err}`));
    }, 250);
    return c.json({ ok: true, note: 'restarting — panel back in ~10s' });
  });

  const host = options.host ?? '127.0.0.1';
  const server = serve({ fetch: app.fetch, port, hostname: host });
  // localhost is always the local URL; when bound wider, note the bind host
  // too so the operator sees it's reachable off-box (and the no-auth caveat).
  if (host === '127.0.0.1') {
    options.log('info', `🖥️  Agent dashboard: http://127.0.0.1:${port}`);
  } else {
    options.log('info', `🖥️  Agent dashboard: http://127.0.0.1:${port} (also bound ${host}:${port} — no auth, trusted network only)`);
  }
  return { port, close: () => server.close() };
}
