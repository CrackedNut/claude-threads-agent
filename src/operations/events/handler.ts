/**
 * Claude event handling module
 *
 * Handles pre/post processing of Claude events, session-specific side effects,
 * and specialized features like compaction handling.
 *
 * NOTE: Main event handling (formatting, tool handling) is done by MessageManager.
 * This module handles session-specific side effects that wrap MessageManager.
 */

import type { Session, SessionUsageStats, ModelTokenUsage } from '../../session/types.js';
import { getSessionStatus, markClaudeResponded, isSessionInterrupted } from '../../session/types.js';
import type { ClaudeEvent } from '../../claude/cli.js';
import { shortenPath } from '../index.js';
import { withErrorHandling } from '../../utils/error-handler/index.js';
import { resetSessionActivity, post, postError, updatePost } from '../post-helpers/index.js';
import type { SessionContext } from '../session-context/index.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';
import { extractPullRequestUrl } from '../../utils/pr-detector.js';
import { changeDirectory, reportBug } from '../commands/index.js';
import { buildWorktreeListMessage } from '../worktree/index.js';
import { trackEvent } from '../bug-report/index.js';
import { scanLoopSentinels, maybeContinueLoop } from '../loop/index.js';
import { parseClaudeCommand, removeCommandFromText, isClaudeAllowedCommand } from '../../commands/index.js';
import { ACK_SEEN_EMOJI, ACK_DONE_EMOJI } from '../../utils/emoji.js';

const log = createLogger('events');
const sessionLog = createSessionLog(log);

// ---------------------------------------------------------------------------
// Claude command detection
// ---------------------------------------------------------------------------

/**
 * Detect and execute commands from Claude's assistant output.
 * Uses the shared command parser with Claude's allowlist.
 * Returns the text with the command removed (if executed), or original text.
 */
function detectAndExecuteClaudeCommands(
  text: string,
  session: Session,
  ctx: SessionContext
): string {
  const parsed = parseClaudeCommand(text);

  if (parsed && isClaudeAllowedCommand(parsed.command)) {
    sessionLog(session).info(`🤖 Claude executing !${parsed.command} ${parsed.args || ''}`);

    // Execute the command asynchronously
    executeClaudeCommand(session, parsed.command, parsed.args || '', ctx);

    // Remove the command from the displayed text
    return removeCommandFromText(text, parsed);
  }

  return text;
}

/**
 * Execute a command on behalf of Claude.
 * Posts a visibility message and runs the command.
 * For commands that produce output, sends the result back to Claude.
 *
 * Only commands in CLAUDE_ALLOWED_COMMANDS can be executed.
 */
async function executeClaudeCommand(
  session: Session,
  command: string,
  args: string,
  ctx: SessionContext
): Promise<void> {
  const formatter = session.platform.getFormatter();

  // Post visibility message so users can see what Claude is doing
  const worktreeContext = session.worktreeInfo
    ? { path: session.worktreeInfo.worktreePath, branch: session.worktreeInfo.branch }
    : undefined;
  const shortArgs = args ? shortenPath(args, undefined, worktreeContext) : '';
  const visibilityMessage = `🤖 ${formatter.formatBold('Claude executed:')} ${formatter.formatCode(`!${command}${shortArgs ? ' ' + shortArgs : ''}`)}`;

  await withErrorHandling(
    () => post(session, 'info', visibilityMessage),
    { action: 'Post Claude command visibility', session }
  );

  // Execute the command based on type
  switch (command) {
    case 'cd':
      // Use session owner's permissions
      // Note: This restarts Claude, so no result can be sent back
      await changeDirectory(session, args, session.startedBy, ctx);
      break;

    case 'worktree list': {
      // Get worktree list and send result back to Claude
      const message = await buildWorktreeListMessage(session);
      if (message === null) {
        await postError(session, `Current directory is not a git repository`);
        // Send error back to Claude too
        if (session.claude?.isRunning()) {
          session.claude.sendMessage(`<command-result command="!worktree list">\nError: Current directory is not a git repository\n</command-result>`);
        }
      } else {
        await post(session, 'info', message);
        // Send the result back to Claude so it can see the worktree list
        if (session.claude?.isRunning()) {
          // Use plain text version for Claude (strip markdown formatting for clarity)
          const plainMessage = message
            .replace(/\*\*([^*]+)\*\*/g, '$1')  // Remove bold
            .replace(/`([^`]+)`/g, '$1');       // Remove code formatting
          session.claude.sendMessage(`<command-result command="!worktree list">\n${plainMessage}\n</command-result>`);
          sessionLog(session).info(`📤 Sent worktree list result back to Claude`);
        }
      }
      break;
    }

    case 'bug':
      // Claude can report bugs it encounters
      await reportBug(session, args, session.startedBy, ctx);
      break;
  }
}

/**
 * Extract and update pull request URL from text.
 * Unlike title/description, PR URLs are detected from the actual content
 * (not from special markers), as Claude outputs them when running gh pr create.
 *
 * Only updates if we don't already have a PR URL (first one wins).
 */
function extractAndUpdatePullRequest(
  text: string,
  session: Session,
  ctx: SessionContext
): void {
  // Skip if we already have a PR URL
  if (session.pullRequestUrl) return;

  const prUrl = extractPullRequestUrl(text);
  if (prUrl) {
    session.pullRequestUrl = prUrl;
    sessionLog(session).info(`🔗 Detected PR URL: ${prUrl}`);

    // Persist and update UI
    ctx.ops.persistSession(session);
    ctx.ops.updateStickyMessage().catch(() => {});
    ctx.ops.updateSessionHeader(session).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Pre/Post Processing for MessageManager integration
// ---------------------------------------------------------------------------

/**
 * Pre-processing for events when using MessageManager.
 * Handles session-specific side effects that should run BEFORE the main event handling.
 */
export function handleEventPreProcessing(
  session: Session,
  event: ClaudeEvent,
  ctx: SessionContext
): void {
  // Log raw event to thread logger (first thing, before any processing)
  session.threadLogger?.logEvent(event);

  // Reset activity and clear timeout tracking (prevents updating stale posts in long threads)
  resetSessionActivity(session);

  // On first meaningful response from Claude, mark session as safe to resume and persist
  if (!session.lifecycle.hasClaudeResponded && (event.type === 'assistant' || event.type === 'tool_use')) {
    markClaudeResponded(session);
    ctx.ops.persistSession(session);
    ctx.ops.emitSessionUpdate(session.sessionId, { status: getSessionStatus(session) });
  }

  // Handle system events specially
  if (event.type === 'system') {
    const e = event as ClaudeEvent & {
      subtype?: string;
      status?: string;
      compact_metadata?: unknown;
      slash_commands?: string[];
    };

    // Capture available slash commands from init event
    if (e.subtype === 'init' && e.slash_commands && Array.isArray(e.slash_commands)) {
      session.availableSlashCommands = new Set(
        e.slash_commands.map((cmd: string) =>
          cmd.startsWith('/') ? cmd.slice(1) : cmd
        )
      );
      sessionLog(session).info(
        `Captured ${session.availableSlashCommands.size} slash commands from init: ${[...session.availableSlashCommands].join(', ')}`
      );
    }

    // Handle compaction events
    if (e.subtype === 'status' && e.status === 'compacting') {
      handleCompactionStart(session, ctx);
    }
    if (e.subtype === 'compact_boundary') {
      handleCompactionComplete(session, e.compact_metadata, ctx);
    }
  }

  // Track tool use events for bug reporting context
  if (event.type === 'tool_use') {
    const tool = event.tool_use as { name: string };
    trackEvent(session, 'tool_use', tool.name);
  }
}

/**
 * Post-processing for events when using MessageManager.
 * Handles session-specific side effects that should run AFTER the main event handling.
 */
export function handleEventPostProcessing(
  session: Session,
  event: ClaudeEvent,
  ctx: SessionContext
): void {
  // Handle assistant events - extract PR URLs, detect commands
  if (event.type === 'assistant') {
    const msg = event.message as {
      content?: Array<{ type: string; text?: string }>;
    };
    for (const block of msg?.content || []) {
      if (block.type === 'text' && block.text) {
        // Detect and store pull request URLs
        extractAndUpdatePullRequest(block.text, session, ctx);
        // Detect and execute Claude commands (e.g., !cd)
        detectAndExecuteClaudeCommands(block.text, session, ctx);
        // Loop mode: watch for LOOP_COMPLETE / LOOP_BLOCKED exit sentinels
        scanLoopSentinels(session, block.text);
      }
    }
  }

  // Handle result events - stop typing, update UI, extract usage, flush queued msgs
  if (event.type === 'result') {
    ctx.ops.stopTyping(session);
    session.isProcessing = false;
    // Swap ack reactions on the user posts that drove this turn: 👀 → ✅.
    // Fire-and-forget; a failed reaction must never block the result pipeline.
    const ackPostIds = session.pendingAckPostIds;
    if (ackPostIds?.length) {
      session.pendingAckPostIds = [];
      for (const ackPostId of ackPostIds) {
        void session.platform.removeReaction(ackPostId, ACK_SEEN_EMOJI).catch(() => {});
        void session.platform.addReaction(ackPostId, ACK_DONE_EMOJI).catch(() => {});
      }
    }
    ctx.ops.emitSessionUpdate(session.sessionId, { status: getSessionStatus(session) });
    updateUsageStats(session, event, ctx);
    // Deliver any messages that were buffered via `!queue` / `!steer` while
    // Claude was processing. Joined with blank lines so Claude sees them as
    // one coherent follow-up. Fire-and-forget — the post is recoverable from
    // logs if it fails, and we don't want to block the result-event pipeline.
    //
    // EXCEPT when an interrupt is in flight (`!steer` / `!escape`): SIGINT
    // makes Claude emit this final result and then EXIT. Delivering the
    // queue now would call handleUserMessage on a dying process and flip the
    // session back to 'active', so the imminent exit lands in handleExit's
    // normal-end path and KILLS the session instead of pausing it (observed
    // 2026-06-11: `!steer` ended the session, then the next message resumed
    // it with the jarring "resumed after bot restart" notice). Leave the
    // queue intact — handleExit pauses + persists it, and resume drains it.
    if (!isSessionInterrupted(session)) {
      // Loop mode rides the same turn boundary: queued user messages win the
      // round (the loop stays armed and re-evaluates at THAT turn's result);
      // otherwise the loop decides continue / complete / cap.
      void flushQueuedUserMessages(session, ctx).then((flushed) =>
        maybeContinueLoop(session, ctx, flushed),
      );
    }
  }

  // Track tool errors for bug reporting context
  if (event.type === 'tool_result') {
    const result = event.tool_result as { is_error?: boolean };
    if (result.is_error) {
      trackEvent(session, 'tool_error', 'Tool execution failed');
    }
  }

  // Handle system errors
  if (event.type === 'system') {
    const e = event as ClaudeEvent & { subtype?: string; error?: string };
    if (e.subtype === 'error') {
      trackEvent(session, 'system_error', String(e.error).substring(0, 80));
    }
  }

}

/**
 * Deliver buffered `!queue` / `!steer` messages now that Claude's turn ended.
 *
 * Joins the queue with blank lines so multiple buffered messages arrive as a
 * single coherent follow-up rather than fragmenting into several turns. The
 * queue is cleared (and persisted) BEFORE the follow-up is dispatched so a
 * crash mid-dispatch doesn't loop the same message.
 */
async function flushQueuedUserMessages(
  session: Session,
  ctx: SessionContext,
): Promise<boolean> {
  const queue = session.queuedUserMessages;
  if (!queue || queue.length === 0) return false;
  const joined = queue.join('\n\n');
  session.queuedUserMessages = undefined;
  try {
    ctx.ops.persistSession(session);
  } catch {
    // Persistence failures are non-fatal; the in-memory clear stands.
  }
  try {
    await session.messageManager?.handleUserMessage(
      joined,
      undefined,
      session.startedBy,
    );
  } catch {
    // Swallowed: this runs from the event pipeline and we don't want to
    // bring the session down on a follow-up dispatch error. The message
    // already lives in the thread log.
  }
  return true;
}

// ---------------------------------------------------------------------------
// Compaction handling
// ---------------------------------------------------------------------------

/**
 * Handle compaction start - create a dedicated post that we can update later.
 */
async function handleCompactionStart(
  session: Session,
  _ctx: SessionContext
): Promise<void> {
  // Close current post (flushes pending content) to avoid mixing with compaction message
  await session.messageManager?.closeCurrentPost();

  // Create the compaction status post
  const formatter = session.platform.getFormatter();
  const message = `🗜️ ${formatter.formatBold('Compacting context...')} ${formatter.formatItalic('(freeing up memory)')}`;
  const compactionPost = await withErrorHandling(
    () => post(session, 'info', message),
    { action: 'Post compaction start', session }
  );

  if (compactionPost) {
    session.compactionPostId = compactionPost.id;
    // Note: post() already calls updateLastMessage internally
  }
}

/**
 * Handle compaction complete - update the existing compaction post.
 */
async function handleCompactionComplete(
  session: Session,
  compactMetadata: unknown,
  _ctx: SessionContext
): Promise<void> {
  // Build the completion message with metadata
  const metadata = compactMetadata as { trigger?: string; pre_tokens?: number } | undefined;
  const trigger = metadata?.trigger || 'auto';
  const preTokens = metadata?.pre_tokens;
  let info = trigger === 'manual' ? 'manual' : 'auto';
  if (preTokens && preTokens > 0) {
    info += `, ${Math.round(preTokens / 1000)}k tokens`;
  }
  const formatter = session.platform.getFormatter();
  const completionMessage = `✅ ${formatter.formatBold('Context compacted')} ${formatter.formatItalic(`(${info})`)}`;

  if (session.compactionPostId) {
    // Update the existing compaction post
    await updatePost(session, session.compactionPostId, completionMessage);
    session.compactionPostId = undefined;
  } else {
    // Fallback: create a new post if we don't have the original
    // Note: post() already calls updateLastMessage internally
    await withErrorHandling(
      () => post(session, 'info', completionMessage),
      { action: 'Post compaction complete', session }
    );
  }
}

// ---------------------------------------------------------------------------
// Usage stats extraction
// ---------------------------------------------------------------------------

/**
 * Result event structure from Claude CLI
 */
interface ResultEvent {
  type: 'result';
  subtype?: string;
  total_cost_usd?: number;
  /** Per-request token usage (accurate for context window calculation) */
  usage?: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
  /** Cumulative billing per model across the session */
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    contextWindow: number;
    costUSD: number;
  }>;
}

/**
 * Convert model ID to display name
 * e.g., "claude-opus-4-5-20251101" -> "Opus 4.5"
 */
function getModelDisplayName(modelId: string): string {
  // Common model name patterns
  if (modelId.includes('opus-4-5') || modelId.includes('opus-4.5')) return 'Opus 4.5';
  if (modelId.includes('opus-4')) return 'Opus 4';
  if (modelId.includes('opus')) return 'Opus';
  if (modelId.includes('sonnet-4')) return 'Sonnet 4';
  if (modelId.includes('sonnet-3-5') || modelId.includes('sonnet-3.5')) return 'Sonnet 3.5';
  if (modelId.includes('sonnet')) return 'Sonnet';
  if (modelId.includes('haiku-4-5') || modelId.includes('haiku-4.5')) return 'Haiku 4.5';
  if (modelId.includes('haiku')) return 'Haiku';
  // Fallback: extract the model family name
  const match = modelId.match(/claude-(\w+)/);
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1) : modelId;
}

/**
 * Extract usage stats from a result event and update session
 */
function updateUsageStats(
  session: Session,
  event: ClaudeEvent,
  ctx: SessionContext
): void {
  const result = event as ResultEvent;

  if (!result.modelUsage) return;

  // Find the primary model (highest cost, usually the main model)
  let primaryModel = '';
  let highestCost = 0;
  let contextWindowSize = 200000; // Default

  const modelUsage: Record<string, ModelTokenUsage> = {};
  let totalTokensUsed = 0;

  for (const [modelId, usage] of Object.entries(result.modelUsage)) {
    modelUsage[modelId] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      contextWindow: usage.contextWindow,
      costUSD: usage.costUSD,
    };

    // Sum all tokens (for billing display)
    totalTokensUsed += usage.inputTokens + usage.outputTokens +
      usage.cacheReadInputTokens + usage.cacheCreationInputTokens;

    // Track primary model by highest cost
    if (usage.costUSD > highestCost) {
      highestCost = usage.costUSD;
      primaryModel = modelId;
      contextWindowSize = usage.contextWindow;
    }
  }

  // Calculate context tokens from per-request usage (accurate)
  // Falls back to primary model's cumulative tokens if usage not available
  let contextTokens = 0;
  if (result.usage) {
    // Per-request usage: actual tokens in current context window
    contextTokens = result.usage.input_tokens +
      result.usage.cache_creation_input_tokens +
      result.usage.cache_read_input_tokens;
  } else if (primaryModel && result.modelUsage[primaryModel]) {
    // Fallback: estimate from primary model's cumulative billing
    const primary = result.modelUsage[primaryModel];
    contextTokens = primary.inputTokens + primary.cacheReadInputTokens;
  }

  // Create or update usage stats
  const usageStats: SessionUsageStats = {
    primaryModel,
    modelDisplayName: getModelDisplayName(primaryModel),
    contextWindowSize,
    contextTokens,
    totalTokensUsed,
    totalCostUSD: result.total_cost_usd || 0,
    modelUsage,
    lastUpdated: new Date(),
  };

  session.usageStats = usageStats;

  const contextPct = contextWindowSize > 0
    ? Math.round((contextTokens / contextWindowSize) * 100)
    : 0;
  sessionLog(session).info(
    `Updated usage stats: ${usageStats.modelDisplayName}, ` +
    `context ${contextTokens}/${contextWindowSize} (${contextPct}%), ` +
    `$${usageStats.totalCostUSD.toFixed(4)}`
  );

  // Start periodic status bar timer if not already running
  if (!session.timers.statusBarTimer) {
    const STATUS_BAR_UPDATE_INTERVAL = 30000; // 30 seconds
    session.timers.statusBarTimer = setInterval(() => {
      // Only update if session is still active
      if (session.claude.isRunning()) {
        // Try to get more accurate context data from status line
        updateUsageFromStatusLine(session);
        ctx.ops.updateSessionHeader(session).catch(() => {});
      }
    }, STATUS_BAR_UPDATE_INTERVAL);
  }

  // Update status bar with new usage info
  ctx.ops.updateSessionHeader(session).catch(() => {});
}

/**
 * Update usage stats from the status line file if available.
 * This provides more accurate context window usage than result events.
 */
function updateUsageFromStatusLine(session: Session): void {
  const statusData = session.claude.getStatusData();
  if (!statusData) return;

  // Only update if we have existing usage stats
  if (!session.usageStats) return;

  // Use total_input_tokens which represents the cumulative context usage
  // (not current_usage which is just the per-request tokens)
  const contextTokens = statusData.total_input_tokens || 0;

  // Update context tokens if the status line data is newer
  if (statusData.timestamp > session.usageStats.lastUpdated.getTime()) {
    session.usageStats.contextTokens = contextTokens;
    session.usageStats.contextWindowSize = statusData.context_window_size;
    session.usageStats.lastUpdated = new Date(statusData.timestamp);

    // Update model info if available
    if (statusData.model) {
      session.usageStats.primaryModel = statusData.model.id;
      session.usageStats.modelDisplayName = statusData.model.display_name;
    }

    // Update cost if available
    if (statusData.cost) {
      session.usageStats.totalCostUSD = statusData.cost.total_cost_usd;
    }

    const contextPct = session.usageStats.contextWindowSize > 0
      ? Math.round((contextTokens / session.usageStats.contextWindowSize) * 100)
      : 0;
    sessionLog(session).debug(
      `Updated from status line: context ${contextTokens}/${session.usageStats.contextWindowSize} (${contextPct}%)`
    );
  }
}

