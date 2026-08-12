/**
 * `openintel chat` entrypoint — terminal chat with a profile's bot.
 *
 * Fallback for when the chat platform (Mattermost/Discord/Slack) is
 * unreachable: spawns an INTERACTIVE Claude CLI carrying the same identity
 * the daemon gives its sessions — persona (SOUL/DIRECTIVES/projects/brain),
 * skills index, working dir, permission mode, and default model — resolved
 * from the profile's config.yaml exactly like a real session spawn.
 *
 * Usage (via the manager script, which sets OPENINTEL_HOME):
 *   node dist/chat.js [--platform <platformId>]
 *
 * `--platform` picks a specific bot's identity when one daemon hosts several
 * (per-platform `agentPersona`/`agent:` overrides); default is the first
 * platform entry, falling back to the daemon-global identity.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { loadConfigWithMigration, resolvePermissionMode } from './config/index.js';
import type {
  AgentPersonaConfig,
  SkillsIndexConfig,
  PlatformInstanceConfig,
  PermissionMode,
} from './config/index.js';
import { personaFromAgentDir } from './config/agent-paths.js';
import { buildAgentPersonaText } from './commands/agent-persona-builder.js';
import { buildSkillsIndexText } from './commands/skills-index-builder.js';

/** Mirror of index.ts resolvePlatformPersona: explicit > agent: shorthand. */
function platformPersona(platform: PlatformInstanceConfig | undefined): {
  agentPersona?: AgentPersonaConfig;
  skillsIndex?: SkillsIndexConfig;
} {
  if (!platform) return {};
  if (platform.agentPersona || platform.skillsIndex) {
    return { agentPersona: platform.agentPersona, skillsIndex: platform.skillsIndex };
  }
  if (typeof platform.agent === 'string' && platform.agent.trim()) {
    return personaFromAgentDir(platform.agent);
  }
  return {};
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~(?=$|\/)/, homedir()) : p;
}

function main(): void {
  const config = loadConfigWithMigration();
  if (!config) {
    console.error('[chat] no config found — is OPENINTEL_HOME set / the profile configured?');
    process.exit(1);
  }

  const argv = process.argv.slice(2);
  const platformFlag = argv.indexOf('--platform');
  const platformId = platformFlag >= 0 ? argv[platformFlag + 1] : undefined;
  const platform = platformId
    ? config.platforms.find((p) => p.id === platformId)
    : config.platforms[0];
  if (platformId && !platform) {
    console.error(`[chat] no platform "${platformId}" in config (have: ${config.platforms.map((p) => p.id).join(', ')})`);
    process.exit(1);
  }

  // Per-bot identity override wins, daemon-global otherwise — the same
  // resolution addPlatform() feeds getPlatformPersona().
  const override = platformPersona(platform);
  const agentPersona = override.agentPersona ?? config.agentPersona;
  const skillsIndex = override.skillsIndex ?? config.skillsIndex;

  const parts: string[] = [];
  const personaText = buildAgentPersonaText(agentPersona);
  if (personaText) parts.push(personaText);
  const skillsText = buildSkillsIndexText(skillsIndex);
  if (skillsText) parts.push(skillsText);
  parts.push(
    'TERMINAL CHAT MODE: you are talking to your operator directly in a ' +
    'terminal via `openintel chat` — typically because the chat platform is ' +
    'unreachable. There is no Mattermost/Discord/Slack session: platform ' +
    '`!commands`, reactions, and chat-platform MCP tools are NOT available. ' +
    'Otherwise you are the same agent with the same identity, memory, and ' +
    'working directory.',
  );
  const appendSystemPrompt = parts.join('\n\n');

  const workingDir = expandHome(config.workingDir || homedir());
  const cwd = existsSync(workingDir) ? workingDir : homedir();

  const args: string[] = ['--append-system-prompt', appendSystemPrompt];
  // Permission mode is a per-platform setting — mirror the bot this chat
  // stands in for; 'default' (interactive prompts) when nothing is set.
  // The base platform interface types extra fields as unknown, so narrow.
  const platformOpts = platform as
    | { permissionMode?: PermissionMode; skipPermissions?: boolean }
    | undefined;
  const mode = resolvePermissionMode({
    permissionMode: platformOpts?.permissionMode,
    skipPermissions: platformOpts?.skipPermissions,
  });
  if (mode === 'bypass') args.push('--dangerously-skip-permissions');
  if (config.defaultModel) args.push('--model', config.defaultModel);

  const claudeBin = process.env.CLAUDE_PATH || 'claude';
  const result = spawnSync(claudeBin, args, { stdio: 'inherit', cwd });
  if (result.error) {
    console.error(`[chat] failed to launch ${claudeBin}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

main();
