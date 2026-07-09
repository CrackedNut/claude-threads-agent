/**
 * Command Executor
 *
 * Unified command execution for both root messages and in-session messages.
 * This is the single place where all commands are handled.
 */

import { COMMAND_REGISTRY } from './registry.js';
import type { PermissionMode } from '../config/index.js';
import type {
  CommandExecutorContext,
  CommandHandler,
  CommandHandlerMap,
  CommandResult,
} from './types.js';
import { generateHelpMessage } from './help-generator.js';
import { getReleaseNotes, formatReleaseNotes } from '../changelog.js';
import { VERSION } from '../version.js';
import { buildChannelHistoryContext } from '../operations/channel-history.js';
import { parseLoopArgs } from '../operations/loop/index.js';

// =============================================================================
// Command Handler Registry
// =============================================================================

const handlers: CommandHandlerMap = new Map();

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get command definition from registry.
 */
function getCommandDef(command: string) {
  return COMMAND_REGISTRY.find((c) => c.command === command);
}

/**
 * Get subcommand definition from a command.
 */
function getSubcommandDef(command: string, subcommand: string) {
  const cmdDef = getCommandDef(command);
  return cmdDef?.subcommands?.find((s) => s.name === subcommand);
}

// =============================================================================
// Command Handlers
// =============================================================================

/**
 * Handle !help command.
 */
const handleHelp: CommandHandler = async (ctx) => {
  const helpMessage = generateHelpMessage(ctx.formatter);
  await ctx.client.createPost(helpMessage, ctx.replyTo);
  return { handled: true };
};

/**
 * Handle !release-notes command.
 */
const handleReleaseNotes: CommandHandler = async (ctx) => {
  const notes = getReleaseNotes(VERSION);
  if (notes) {
    await ctx.client.createPost(formatReleaseNotes(notes, ctx.formatter), ctx.replyTo);
  } else {
    await ctx.client.createPost(
      `📋 ${ctx.formatter.formatBold(`claude-threads v${VERSION}`)}\n\nRelease notes not available. See ${ctx.formatter.formatLink('GitHub releases', 'https://github.com/anneschuth/claude-threads/releases')}.`,
      ctx.replyTo
    );
  }
  return { handled: true };
};

/**
 * Handle !update command.
 */
const handleUpdate: CommandHandler = async (ctx, args) => {
  const subcommand = args?.toLowerCase();

  if (ctx.commandContext === 'first-message') {
    // First message: just show status without starting session
    await ctx.sessionManager.showUpdateStatusWithoutSession(
      ctx.client.platformId,
      ctx.threadId
    );
    return { handled: true };
  }

  // In-session: handle subcommands
  if (subcommand === 'now') {
    await ctx.sessionManager.forceUpdateNow(ctx.threadId, ctx.username);
  } else if (subcommand === 'defer') {
    await ctx.sessionManager.deferUpdate(ctx.threadId, ctx.username);
  } else {
    await ctx.sessionManager.showUpdateStatus(ctx.threadId, ctx.username);
  }
  return { handled: true };
};

/**
 * Handle !stop command.
 */
const handleStop: CommandHandler = async (ctx) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false }; // !stop doesn't work in first message
  }
  if (ctx.isAllowed) {
    await ctx.sessionManager.cancelSession(ctx.threadId, ctx.username);
  }
  return { handled: true };
};

/**
 * Handle !queue command — buffer a user message to deliver when Claude's
 * current turn ends. If Claude is idle the message is sent immediately as a
 * follow-up, matching the user's "send this when Claude is free" intent.
 */
const handleQueue: CommandHandler = async (ctx, args) => {
  if (ctx.commandContext === 'first-message') return { handled: false };
  if (!ctx.isAllowed) return { handled: true };
  if (!args || !args.trim()) {
    await ctx.client.createPost(
      `❌ Usage: ${ctx.formatter.formatCode('!queue <message>')}`,
      ctx.replyTo,
    );
    return { handled: true };
  }
  await ctx.sessionManager.queueMessage(ctx.threadId, args.trim(), ctx.username);
  return { handled: true };
};

/**
 * Handle !steer command — interrupt Claude and enqueue a redirect.
 * Unlike `!queue`, `!steer` always interrupts (even if Claude is idle,
 * in which case the redirect is delivered immediately) and wraps the
 * message with a `STEER:` prefix so Claude reads it as a direction change
 * rather than a follow-up question.
 */
const handleSteer: CommandHandler = async (ctx, args) => {
  if (ctx.commandContext === 'first-message') return { handled: false };
  if (!ctx.isAllowed) return { handled: true };
  if (!args || !args.trim()) {
    await ctx.client.createPost(
      `❌ Usage: ${ctx.formatter.formatCode('!steer <message>')}`,
      ctx.replyTo,
    );
    return { handled: true };
  }
  await ctx.sessionManager.steerSession(ctx.threadId, args.trim(), ctx.username);
  return { handled: true };
};

/**
 * Handle !loop command — autonomous goal loop.
 *
 * First message: `@bot !loop <goal>` arms loop mode on the new session; the
 * goal doubles as the session's initial prompt. In-session: `!loop <goal>`
 * arms (kicking immediately if Claude is idle), `!loop stop` disarms,
 * `!loop status` reports. `!loop <n> <goal>` caps auto-continues at n.
 */
const handleLoop: CommandHandler = async (ctx, args) => {
  const trimmed = args?.trim();
  const sub = trimmed?.toLowerCase();

  if (ctx.commandContext === 'first-message') {
    // stop/status make no sense before a session exists; empty goal falls
    // through to the "mention me with your request" path.
    if (!trimmed || sub === 'stop' || sub === 'off' || sub === 'status') {
      return { handled: false };
    }
    const { goal, maxTurns } = parseLoopArgs(trimmed);
    return {
      sessionOptions: { loop: { goal, maxTurns } },
      // The goal IS the session prompt.
      remainingText: goal,
      continueProcessing: true,
    };
  }

  if (!ctx.isAllowed) return { handled: true };

  if (!trimmed) {
    await ctx.client.createPost(
      `❌ Usage: ${ctx.formatter.formatCode('!loop <goal>')} — or ${ctx.formatter.formatCode('!loop stop')} / ${ctx.formatter.formatCode('!loop status')}`,
      ctx.replyTo,
    );
    return { handled: true };
  }
  if (sub === 'stop' || sub === 'off') {
    await ctx.sessionManager.stopLoop(ctx.threadId, ctx.username);
    return { handled: true };
  }
  if (sub === 'status') {
    await ctx.sessionManager.loopStatus(ctx.threadId);
    return { handled: true };
  }

  const { goal, maxTurns } = parseLoopArgs(trimmed);
  await ctx.sessionManager.armLoop(ctx.threadId, goal, maxTurns, ctx.username);
  return { handled: true };
};

/**
 * Handle !import command — cross-chat context handoff.
 *
 * `!import last` (or no ref) pulls the most recent archived session;
 * `!import <session-id-or-prefix>` pulls a specific one (ids come from
 * `!search` hits). First message: the transcript seeds the new session's
 * prompt. In-session: the transcript is delivered as a follow-up.
 */
const handleImport: CommandHandler = async (ctx, args) => {
  const trimmed = args?.trim() ?? '';
  // A leading "last" or id-looking token (hex/dash, 6+ chars) is the session
  // ref; everything after it is the prompt. No such token → ref defaults to
  // "last" and the whole text is the prompt.
  const m = trimmed.match(/^(last|[0-9a-fA-F][0-9a-fA-F-]{5,36})(?:\s+([\s\S]*))?$/);
  const ref = m ? m[1] : 'last';
  const promptText = ((m ? m[2] : trimmed) ?? '').trim();

  if (ctx.commandContext === 'first-message') {
    return {
      sessionOptions: { importSessionRef: ref },
      remainingText: promptText || 'Continue from the imported context above.',
      continueProcessing: true,
    };
  }

  if (!ctx.isAllowed) return { handled: true };
  await ctx.sessionManager.importContext(ctx.threadId, ref, ctx.username);
  return { handled: true };
};

/**
 * Handle !escape command.
 */
const handleEscape: CommandHandler = async (ctx) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false }; // !escape doesn't work in first message
  }
  if (ctx.isAllowed) {
    await ctx.sessionManager.interruptSession(ctx.threadId, ctx.username);
  }
  return { handled: true };
};

/**
 * Handle !approve command.
 */
const handleApprove: CommandHandler = async (ctx) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false }; // !approve doesn't work in first message
  }
  if (ctx.isAllowed) {
    await ctx.sessionManager.approvePendingPlan(ctx.threadId, ctx.username);
  }
  return { handled: true };
};

/**
 * Handle !invite command.
 */
const handleInvite: CommandHandler = async (ctx, args) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false }; // !invite doesn't work in first message
  }
  if (args) {
    await ctx.sessionManager.inviteUser(ctx.threadId, args, ctx.username);
  }
  return { handled: true };
};

/**
 * Handle !kick command.
 */
const handleKick: CommandHandler = async (ctx, args) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false }; // !kick doesn't work in first message
  }
  if (args) {
    await ctx.sessionManager.kickUser(ctx.threadId, args, ctx.username);
  }
  return { handled: true };
};

/**
 * Handle !github-email command — self-only, no isAllowed gate. Anyone in the
 * thread (including unauthorized senders) can register their address; this is
 * what makes the !invite onboarding flow practical. The handler itself only
 * mutates the caller's own entry so there's no privilege-escalation surface.
 */
const handleGitHubEmail: CommandHandler = async (ctx, args) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false };
  }
  await ctx.sessionManager.setGitHubEmail(ctx.threadId, ctx.username, args);
  return { handled: true };
};

/**
 * Handle !cd command.
 */
const handleCd: CommandHandler = async (ctx, args) => {
  if (!args) {
    return { handled: false };
  }

  if (ctx.commandContext === 'first-message') {
    // First message: store in session options for later
    return {
      sessionOptions: { workingDir: args },
      continueProcessing: true,
    };
  }

  // In-session: change directory immediately
  await ctx.sessionManager.changeDirectory(ctx.threadId, args, ctx.username);
  return { handled: true };
};

/**
 * Normalize a `!permissions` argument to one of the three canonical modes.
 * Accepts `default`, `auto`, `bypass` directly plus legacy aliases
 * `interactive` (→ default) and `skip` (→ bypass).
 * Returns null for unknown values.
 */
function parsePermissionMode(
  arg: string | undefined,
): PermissionMode | null {
  switch (arg?.toLowerCase()) {
    case 'default':
    case 'interactive':
      return 'default';
    case 'auto':
      return 'auto';
    case 'bypass':
    case 'skip':
      return 'bypass';
    default:
      return null;
  }
}

/**
 * Handle !permissions command.
 *
 * Accepts `default` | `auto` | `bypass` (canonical) and `interactive` | `skip`
 * (legacy aliases). In first-message context, sets the session's initial mode.
 * In-session, respawns Claude with the new mode.
 */
const handlePermissions: CommandHandler = async (ctx, args) => {
  const mode = parsePermissionMode(args);

  if (ctx.commandContext === 'first-message') {
    if (mode) {
      return {
        sessionOptions: {
          permissionMode: mode,
          // Legacy field kept in sync so older consumers still see the downgrade.
          forceInteractivePermissions: mode === 'default',
        },
        continueProcessing: true,
      };
    }
    return { handled: false };
  }

  // In-session: change mode and respawn.
  if (!mode) {
    await ctx.client.createPost(
      `⚠️ Unknown permission mode. Usage: \`!permissions default|auto|bypass\` (aliases: \`interactive\`, \`skip\`).`,
      ctx.replyTo,
    );
    return { handled: true };
  }

  await ctx.sessionManager.setSessionPermissionMode(ctx.threadId, ctx.username, mode);
  return { handled: true };
};

/**
 * Handle `!model` — post the numbered model picker for the user to react to.
 * In-session only (there must be a session to set the model on). `--default`
 * makes the eventual pick also persist as the bot-wide default.
 */
const handleModel: CommandHandler = async (ctx, args) => {
  if (ctx.commandContext === 'first-message') {
    // No active session yet — nothing to repoint. Tell the user.
    await ctx.client.createPost(
      `ℹ️ ${ctx.formatter.formatCode('!model')} works inside an active session. Start one, then run it.`,
      ctx.replyTo,
    );
    return { handled: true };
  }
  if (!ctx.isAllowed) return { handled: true };
  const setDefault = (args ?? '').trim().toLowerCase() === '--default';
  await ctx.sessionManager.showModelPicker(ctx.threadId, ctx.username, setDefault);
  return { handled: true };
};

/**
 * Parse `!thread` arguments: an optional topic plus an optional `-history`
 * (or `--history`) flag, which may appear anywhere in the arg string.
 *
 *   "fix the auth bug"           → { topic: "fix the auth bug", includeHistory: false }
 *   "fix the auth bug -history"  → { topic: "fix the auth bug", includeHistory: true }
 *   "-history"                   → { topic: undefined, includeHistory: true }
 *
 * The flag must be a standalone token — words that merely contain
 * "-history" (e.g. "pre-history") are left in the topic.
 */
export function parseThreadArgs(
  args: string | undefined,
): { topic?: string; includeHistory: boolean } {
  if (!args?.trim()) return { includeHistory: false };
  const kept: string[] = [];
  let includeHistory = false;
  for (const token of args.trim().split(/\s+/)) {
    if (/^--?history$/i.test(token)) {
      includeHistory = true;
      continue;
    }
    kept.push(token);
  }
  const topic = kept.join(' ').trim();
  return { topic: topic || undefined, includeHistory };
}

/**
 * Handle !thread command.
 *
 * First-message (`@bot !thread <prompt>` at channel root): opts out of
 * channel-mode. Only sets a flag — the routing (re-anchoring the session
 * at the @mention post, extracting `-history` from the prompt) lives in
 * the message handler, because `threadRoot`/`channelMode` are
 * message-handler concepts.
 *
 * In-session inside a CHANNEL-mode session (`!thread [topic] [-history]`
 * typed at channel root while the shared session is running): spawns a
 * brand-new thread-mode session — its own Claude instance — anchored to a
 * fresh 🧵 root post, leaving the channel session untouched. `topic` seeds
 * the prompt and session title; `-history` seeds the new session with the
 * recent channel conversation (default: fresh start).
 *
 * In-session inside a THREAD-mode session: no-op hint. Switching a live
 * session's mode would lose context (persisted threadId, sticky message,
 * and collaborator allowlist are all keyed on it).
 */
const handleThread: CommandHandler = async (ctx, args) => {
  if (ctx.commandContext === 'first-message') {
    return {
      sessionOptions: { forceThreadMode: true },
      continueProcessing: true,
    };
  }

  const platformId = ctx.client.platformId;
  const channelSession = ctx.sessionManager.findChannelSession(platformId, ctx.threadId);
  if (channelSession) {
    if (!ctx.isAllowed) return { handled: true };
    const { topic, includeHistory } = parseThreadArgs(args);

    // A fresh root post is the new thread's anchor. We cannot thread off
    // the user's `!thread` post here — it was consumed by this command and
    // threading off it would bury the new session under a bare "!thread".
    // Target the channel session's own channel (ctx.threadId carries the
    // channelId here; the client resolves it to a root-less post).
    const anchor = await ctx.client.createPost(
      `🧵 ${ctx.formatter.formatBold(topic ?? 'Thread session')} — started by ${ctx.formatter.formatUserMention(ctx.username)}`,
      ctx.threadId,
    );

    let prompt =
      topic ??
      'The user opened a fresh thread session from the channel. Briefly confirm you are ready and ask what they want to work on.';
    if (includeHistory) {
      const historyContext = await buildChannelHistoryContext(
        ctx.client,
        ctx.triggeringPostId,
        ctx.threadId, // the channel session's channel
      );
      if (historyContext) prompt = `${historyContext}${prompt}`;
    }

    // Platforms with real thread CHANNELS (Discord): create the native thread
    // off the anchor and run a channel-mode session INSIDE it — on those
    // platforms a thread is just another channel. Reply-threading platforms
    // (Mattermost/Slack) anchor a thread-mode session off the anchor post id.
    if (ctx.client.createThread) {
      const nativeThread = await ctx.client.createThread(ctx.threadId, anchor.id, topic ?? 'Claude session');
      if ('error' in nativeThread) {
        // No reply-threading fallback on native-thread platforms — a session
        // anchored at a post id can't post anywhere. Fail loudly instead.
        await ctx.client.createPost(
          `⚠️ Couldn't start a thread session: ${nativeThread.error}`,
          ctx.threadId,
        );
        return { handled: true };
      }
      await ctx.sessionManager.startSession(
        { prompt },
        ctx.username,
        nativeThread.id,
        platformId,
        undefined,
        ctx.triggeringPostId,
        { channelMode: { channelId: nativeThread.id }, threadTopic: topic, originChannelId: nativeThread.id },
      );
    } else {
      await ctx.sessionManager.startSession(
        { prompt },
        ctx.username,
        anchor.id,
        platformId,
        undefined,
        ctx.triggeringPostId,
        // originChannelId keeps the MCP child and reply routing in the
        // channel the !thread came from (no-op for the home channel).
        { forceThreadMode: true, threadTopic: topic, originChannelId: ctx.threadId },
      );
    }
    return { handled: true };
  }

  // Thread-mode session: keep the friendly hint, but post it to the safe
  // reply target (ctx.replyTo) — never ctx.threadId, see CommandExecutorContext.
  await ctx.client.createPost(
    `ℹ️ ${ctx.formatter.formatBold('!thread')} starts a new thread session from the channel root. ` +
      `This session already lives in its own thread — just keep replying here.`,
    ctx.replyTo,
  );
  return { handled: true };
};

/**
 * Handle !worktree command (unified handling for subcommands and branch creation).
 */
const handleWorktree: CommandHandler = async (ctx, args) => {
  const parts = args?.split(/\s+/) || [];
  const subcommandOrBranch = parts[0]?.toLowerCase();
  const subArgs = parts.slice(1).join(' ');
  const originalFirstArg = parts[0]; // Keep original case for branch names

  // Check if this is a known subcommand
  const subDef = getSubcommandDef('worktree', subcommandOrBranch);

  if (subDef) {
    // Check if subcommand works in current context
    if (ctx.commandContext === 'first-message' && !subDef.worksInFirstMessage) {
      return { handled: false };
    }

    // Handle known subcommands
    switch (subcommandOrBranch) {
      case 'list':
        // In first-message context, use session-less version
        if (ctx.commandContext === 'first-message') {
          await ctx.sessionManager.listWorktreesWithoutSession(ctx.client.platformId, ctx.threadId);
        } else {
          await ctx.sessionManager.listWorktreesCommand(ctx.threadId, ctx.username);
        }
        return { handled: true };

      case 'switch': {
        if (!subArgs) {
          await ctx.client.createPost(
            `❌ Usage: ${ctx.formatter.formatCode('!worktree switch <branch>')}`,
            ctx.replyTo
          );
          return { handled: true };
        }

        // Parse branch name (first word) and remaining text as prompt
        const switchParts = subArgs.split(/\s+/);
        const branchName = switchParts[0];
        const remainingPrompt = switchParts.slice(1).join(' ').trim();

        if (ctx.commandContext === 'first-message') {
          // First message: if there's a prompt, start session in that worktree
          if (remainingPrompt) {
            return {
              worktreeBranch: branchName,
              continueProcessing: false,
              remainingText: remainingPrompt,
              sessionOptions: { switchToExisting: true },
            };
          }
          // No prompt - just switch without starting session
          await ctx.sessionManager.switchToWorktreeWithoutSession(
            ctx.client.platformId,
            ctx.threadId,
            branchName
          );
          return { handled: true };
        }

        // In-session: switch to worktree
        await ctx.sessionManager.switchToWorktree(ctx.threadId, branchName, ctx.username);
        return { handled: true };
      }

      case 'remove':
        if (!subArgs) {
          await ctx.client.createPost(
            `❌ Usage: ${ctx.formatter.formatCode('!worktree remove <branch>')}`,
            ctx.replyTo
          );
          return { handled: true };
        }
        await ctx.sessionManager.removeWorktreeCommand(ctx.threadId, subArgs, ctx.username);
        return { handled: true };

      case 'cleanup':
        await ctx.sessionManager.cleanupWorktreeCommand(ctx.threadId, ctx.username);
        return { handled: true };

      case 'off':
        await ctx.sessionManager.disableWorktreePrompt(ctx.threadId, ctx.username);
        return { handled: true };
    }
  }

  // Not a subcommand - treat as branch name
  if (originalFirstArg) {
    if (ctx.commandContext === 'first-message') {
      // First message: return branch name for session creation
      return {
        worktreeBranch: originalFirstArg,
        continueProcessing: true,
        remainingText: subArgs || undefined,
      };
    }

    // In-session: create worktree immediately
    await ctx.sessionManager.createAndSwitchToWorktree(ctx.threadId, originalFirstArg, ctx.username);
    return { handled: true };
  }

  return { handled: false };
};

/**
 * Handle !bug command.
 */
const handleBug: CommandHandler = async (ctx, args) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false }; // !bug doesn't work in first message
  }
  if (ctx.isAllowed) {
    await ctx.sessionManager.reportBug(ctx.threadId, args, ctx.username, ctx.files);
  }
  return { handled: true };
};

/**
 * Handle !plugin command.
 */
const handlePlugin: CommandHandler = async (ctx, args) => {
  if (ctx.commandContext === 'first-message') {
    return { handled: false }; // !plugin doesn't work in first message
  }
  if (!ctx.isAllowed) {
    return { handled: true };
  }

  const parts = args?.split(/\s+/) || [];
  const subcommand = parts[0]?.toLowerCase() || 'list';
  const pluginName = parts.slice(1).join(' ');

  switch (subcommand) {
    case 'list':
      await ctx.sessionManager.pluginList(ctx.threadId);
      break;
    case 'install':
      if (!pluginName) {
        await ctx.client.createPost(
          `❌ Usage: ${ctx.formatter.formatCode('!plugin install <plugin-name>')}`,
          ctx.replyTo
        );
      } else {
        await ctx.sessionManager.pluginInstall(ctx.threadId, pluginName, ctx.username);
      }
      break;
    case 'uninstall':
      if (!pluginName) {
        await ctx.client.createPost(
          `❌ Usage: ${ctx.formatter.formatCode('!plugin uninstall <plugin-name>')}`,
          ctx.replyTo
        );
      } else {
        await ctx.sessionManager.pluginUninstall(ctx.threadId, pluginName, ctx.username);
      }
      break;
    default:
      await ctx.client.createPost(
        `❌ Unknown subcommand: ${ctx.formatter.formatCode(subcommand)}. Use ${ctx.formatter.formatCode('list')}, ${ctx.formatter.formatCode('install')}, or ${ctx.formatter.formatCode('uninstall')}.`,
        ctx.replyTo
      );
  }
  return { handled: true };
};

/**
 * Handle `!search <query>` — substring-greps the bot's JSONL thread archives.
 *
 * Default scope is the current thread. Two opt-in scopes broaden the search:
 *   - `!search platform <query>` — every session this bot ran on the same
 *     platform instance (still bounded to one channel's bot deployment).
 *   - `!search all <query>` — every platform this bot has logged. Operator
 *     scope; only useful in the bot-admin channel.
 *
 * No first-message support: in that context the bot has no session yet, so
 * "current thread" is ambiguous.
 */
const handleSearch: CommandHandler = async (ctx, args) => {
  if (ctx.commandContext === 'first-message') return { handled: false };
  if (!ctx.isAllowed) return { handled: true };
  if (!args) {
    await ctx.client.createPost(
      `❌ Usage: ${ctx.formatter.formatCode('!search <query>')} (or ${ctx.formatter.formatCode('!search platform <query>')} / ${ctx.formatter.formatCode('!search all <query>')}).`,
      ctx.replyTo,
    );
    return { handled: true };
  }
  const trimmed = args.trim();
  let scope: 'thread' | 'platform' | 'all' = 'thread';
  let query = trimmed;
  const scopeMatch = trimmed.match(/^(thread|platform|all)\s+(.+)$/i);
  if (scopeMatch) {
    scope = scopeMatch[1].toLowerCase() as 'thread' | 'platform' | 'all';
    query = scopeMatch[2].trim();
  }
  if (!query) {
    await ctx.client.createPost(`❌ Empty search query.`, ctx.replyTo);
    return { handled: true };
  }
  await ctx.sessionManager.searchArchiveCommand(
    ctx.threadId,
    ctx.username,
    query,
    scope,
  );
  return { handled: true };
};

/**
 * Create a passthrough handler for Claude Code slash commands.
 */
/**
 * Handle !context. Two modes on one command:
 *   - `!context <channel_id> [n]` → pull the last N (default 30) live messages
 *     from ANOTHER channel into this session as context (cross-channel recall).
 *     Channel ids: Mattermost 26-char [a-z0-9]; Discord 17-20 digit snowflake.
 *   - `!context` (no channel id) → passthrough to Claude's `/context` (token usage).
 */
const CHANNEL_ID_RE = /^([a-z0-9]{15,32}|\d{17,20})(?:\s+(\d{1,3}))?$/i;
const handleContext: CommandHandler = async (ctx, args) => {
  const trimmed = args?.trim() ?? '';
  const m = trimmed.match(CHANNEL_ID_RE);
  if (m) {
    // Cross-channel recall. In-session only (needs a live session to inject into).
    if (ctx.commandContext === 'first-message') {
      await ctx.client.createPost(
        `ℹ️ ${ctx.formatter.formatCode('!context <channel_id> [n]')} works inside a running session — mention me first, then pull a channel's context.`,
        ctx.replyTo,
      );
      return { handled: true };
    }
    if (!ctx.isAllowed) return { handled: true };
    const channelId = m[1];
    const limit = Math.min(Math.max(m[2] ? parseInt(m[2], 10) : 30, 1), 200);
    await ctx.sessionManager.channelContext(ctx.threadId, channelId, limit, ctx.username);
    return { handled: true };
  }
  // No channel id → Claude's /context passthrough (token usage report).
  if (ctx.commandContext === 'first-message') return { handled: false };
  if (ctx.isAllowed) {
    await ctx.sessionManager.sendFollowUp(ctx.threadId, `/context`, undefined, undefined, undefined, { system: true });
  }
  return { handled: true };
};

function createPassthroughHandler(slashCommand: string): CommandHandler {
  return async (ctx) => {
    if (ctx.commandContext === 'first-message') {
      return { handled: false }; // Passthrough commands don't work in first message
    }
    if (ctx.isAllowed) {
      // Authorization was already verified upstream (ctx.isAllowed). Mark this
      // as a system follow-up so the sink's identity gate (#388) does not
      // reject it for lacking a username.
      await ctx.sessionManager.sendFollowUp(ctx.threadId, `/${slashCommand}`, undefined, undefined, undefined, { system: true });
    }
    return { handled: true };
  };
}

// =============================================================================
// Register Handlers
// =============================================================================

handlers.set('help', handleHelp);
handlers.set('release-notes', handleReleaseNotes);
handlers.set('update', handleUpdate);
handlers.set('stop', handleStop);
handlers.set('escape', handleEscape);
handlers.set('queue', handleQueue);
handlers.set('steer', handleSteer);
handlers.set('loop', handleLoop);
handlers.set('import', handleImport);
handlers.set('approve', handleApprove);
handlers.set('invite', handleInvite);
handlers.set('kick', handleKick);
handlers.set('github-email', handleGitHubEmail);
handlers.set('cd', handleCd);
handlers.set('permissions', handlePermissions);
handlers.set('model', handleModel);
handlers.set('thread', handleThread);
handlers.set('worktree', handleWorktree);
handlers.set('bug', handleBug);
handlers.set('plugin', handlePlugin);
handlers.set('search', handleSearch);

// Passthrough commands
handlers.set('context', handleContext);
handlers.set('cost', createPassthroughHandler('cost'));
handlers.set('compact', createPassthroughHandler('compact'));

// =============================================================================
// Main Execution Function
// =============================================================================

/**
 * Execute a command in the given context.
 *
 * @param command - The command name (without !)
 * @param args - Command arguments
 * @param ctx - Execution context
 * @returns CommandResult indicating what happened
 */
export async function executeCommand(
  command: string,
  args: string | undefined,
  ctx: CommandExecutorContext
): Promise<CommandResult> {
  const cmdDef = getCommandDef(command);

  // Check if command exists
  if (!cmdDef) {
    return { handled: false };
  }

  // Check if command works in current context
  if (ctx.commandContext === 'first-message' && !cmdDef.worksInFirstMessage) {
    return { handled: false };
  }

  // Get the handler
  const handler = handlers.get(command);
  if (!handler) {
    return { handled: false };
  }

  // Execute the handler
  return handler(ctx, args);
}

/**
 * Check if a command is a dynamic slash command (passthrough to Claude Code).
 * These are commands like !review that come from Claude Code's init event.
 */
export function isDynamicSlashCommand(
  command: string,
  availableSlashCommands?: Set<string>
): boolean {
  // Check if it's a known command first
  if (handlers.has(command)) {
    return false;
  }
  // Check if it's in the available slash commands from Claude Code
  return availableSlashCommands?.has(command) ?? false;
}

/**
 * Handle a dynamic slash command by passing it through to Claude Code.
 */
export async function handleDynamicSlashCommand(
  command: string,
  args: string | undefined,
  ctx: CommandExecutorContext
): Promise<CommandResult> {
  if (ctx.commandContext === 'first-message') {
    return { handled: false };
  }
  if (ctx.isAllowed) {
    const fullCommand = args ? `/${command} ${args}` : `/${command}`;
    // Authorization verified upstream (ctx.isAllowed); flag as system so the
    // sink's identity gate (#388) does not reject this username-less call.
    await ctx.sessionManager.sendFollowUp(ctx.threadId, fullCommand, undefined, undefined, undefined, { system: true });
  }
  return { handled: true };
}
