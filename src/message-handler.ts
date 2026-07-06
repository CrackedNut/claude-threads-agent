/**
 * Message Handler Module
 *
 * Extracted from index.ts to allow reuse in both the main bot and integration tests.
 * This ensures tests exercise the actual bot logic, not a duplicate.
 */

import type { PlatformClient, PlatformPost, PlatformUser } from './platform/index.js';
import type { SessionManager } from './session/index.js';
import {
  parseCommand,
  parseCommandWithRemainder,
  executeCommand,
  isDynamicSlashCommand,
  handleDynamicSlashCommand,
  COMMAND_REGISTRY,
  type CommandExecutorContext,
} from './commands/index.js';
import type { InitialSessionOptions } from './session/types.js';
import { logSilentError } from './utils/error-handler/index.js';
import { buildChannelHistoryContext } from './operations/channel-history.js';
import { ACK_SEEN_EMOJI } from './utils/emoji.js';

/**
 * Logger interface for message handler
 */
export interface MessageHandlerLogger {
  error(message: string): void;
  debug?(message: string): void;
}

/**
 * Options for message handler
 */
export interface MessageHandlerOptions {
  platformId: string;
  logger?: MessageHandlerLogger;
  /**
   * Called when !kill command is executed. In production this calls process.exit(0).
   * In tests this can just disconnect without exiting.
   */
  onKill?: (username: string) => void | Promise<void>;
}

/**
 * Handle an incoming message from a platform.
 *
 * This is the core message handling logic extracted from index.ts.
 * Both the main bot and integration tests use this same code.
 */
export async function handleMessage(
  client: PlatformClient,
  session: SessionManager,
  post: PlatformPost,
  user: PlatformUser | null,
  options: MessageHandlerOptions
): Promise<void> {
  const { platformId, logger, onKill } = options;
  const username = user?.username || 'unknown';
  const message = post.message;
  const formatter = client.getFormatter();

  // Mode is decided per-message from where the post lands. No config flag.
  //
  // - `post.rootId` set → it's a thread reply → route to thread-mode session
  //   keyed by `platformId:threadRoot`; bot replies inside the thread.
  // - `post.rootId` empty → it's a channel root post → route to the shared
  //   channel-mode session keyed by `platformId:channelId`; bot replies as
  //   channel root posts; every allowed user in the channel participates.
  //
  // Both modes can coexist in the same channel: a shared channel-mode
  // session at the root plus any number of thread-mode sessions inside
  // threads in that channel.
  //
  // With `allChannels` every channel the bot is a member of behaves the
  // same way: root posts route to THAT channel's shared channel-mode
  // session (keyed `platformId:channelId`), and `!thread` opts a
  // conversation out into its own thread.
  const isChannelPost = !post.rootId;
  // `threadRoot` is the routing key: the channelId for channel posts (the
  // second segment of the composite session key), the thread root post id
  // otherwise. It doubles as the reply target — the platform clients
  // recognize a channelId target and post at that channel's root.
  const threadRoot = isChannelPost ? post.channelId : (post.rootId || post.id);
  const directReplyTo = threadRoot;

  try {
    // Check for !kill command (emergency shutdown)
    const lowerMessage = message.trim().toLowerCase();
    if (
      lowerMessage === '!kill' ||
      (client.isBotMentioned(message) && client.extractPrompt(message).toLowerCase() === '!kill')
    ) {
      if (!client.isUserAllowed(username)) {
        await client.createPost(`⛔ Only authorized users can use ${formatter.formatCode('!kill')}`, directReplyTo);
        return;
      }
      // Post confirmation to the channel where !kill was issued
      const activeCount = session.registry.getActiveThreadIds().length;
      try {
        await client.createPost(
          `🔴 ${formatter.formatBold('EMERGENCY SHUTDOWN')} initiated by ${formatter.formatUserMention(username)} - killing ${activeCount} active session${activeCount !== 1 ? 's' : ''}`,
          threadRoot
        );
      } catch (err) {
        logSilentError('kill-confirmation-post', err);
      }

      // Notify all other active sessions before killing
      for (const tid of session.registry.getActiveThreadIds()) {
        if (tid === threadRoot) continue; // Skip the thread where we already posted
        try {
          await client.createPost(`🔴 ${formatter.formatBold('EMERGENCY SHUTDOWN')} by ${formatter.formatUserMention(username)}`, tid);
        } catch (err) {
          logSilentError('kill-notify-session', err);
        }
      }
      logger?.error(`EMERGENCY SHUTDOWN initiated by @${username}`);
      await session.killAllSessions();
      client.disconnect();
      // Call the kill callback (production calls process.exit, tests just return)
      await onKill?.(username);
      return;
    }

    // Follow-up in active session.
    //
    // Thread post → look up by threadRoot (the existing thread-mode path).
    // Channel post → look up the shared channel-mode session by channelId.
    // The two lookups are mode-scoped: a thread-mode session whose
    // threadId happens to match a channelId is NOT reachable via
    // `findChannelSession`, so the modes can't cross.
    const activeSession = isChannelPost
      ? session.findChannelSession(platformId, post.channelId)
      : session.registry.findByThreadId(threadRoot);
    if (activeSession) {
      // If message starts with @mention to someone else, track it as side conversation (if from approved user)
      const mentionMatch = message.trim().match(/^@([\w.-]+)/);
      if (mentionMatch && mentionMatch[1].toLowerCase() !== client.getBotName().toLowerCase()) {
        // Track side conversation if from approved user
        if (session.isUserAllowedInSession(threadRoot, username)) {
          session.addSideConversation(threadRoot, {
            fromUser: username,
            mentionedUser: mentionMatch[1],
            message: message,
            timestamp: new Date(),
            postId: post.id,
          });
        }
        return; // Side conversation, don't interrupt
      }

      const content = client.isBotMentioned(message)
        ? client.extractPrompt(message)
        : message.trim();

      // Parse command using shared parser
      const parsed = parseCommand(content);
      if (parsed) {
        const isAllowed = session.isUserAllowedInSession(threadRoot, username);

        // Build executor context
        const ctx: CommandExecutorContext = {
          commandContext: 'in-session',
          threadId: threadRoot,
          // Reply target for direct createPost calls. At channel root this
          // carries the channelId — platform clients recognize channel
          // targets and post root-less in that channel (the old "Invalid
          // RootId" 400 class is handled at the client now).
          replyTo: directReplyTo,
          triggeringPostId: post.id,
          username,
          client,
          sessionManager: session,
          formatter,
          isAllowed,
          files: post.metadata?.files,
        };

        // Try unified command executor
        const result = await executeCommand(parsed.command, parsed.args, ctx);
        if (result.handled) {
          return;
        }

        // Handle dynamic slash commands (from Claude CLI's init event)
        const defaultPassthroughCommands = new Set(['context', 'cost', 'compact']);
        const availableCommands = activeSession.availableSlashCommands ?? defaultPassthroughCommands;

        if (isDynamicSlashCommand(parsed.command, availableCommands)) {
          const dynamicResult = await handleDynamicSlashCommand(parsed.command, parsed.args, ctx);
          if (dynamicResult.handled) {
            return;
          }
        }

        // Kill is handled earlier in the code, so we just return
        if (parsed.command === 'kill') {
          return;
        }

        // Unknown command - don't treat as regular message
        return;
      }

      // Check for pending worktree prompt - treat message as branch name response
      if (session.hasPendingWorktreePrompt(threadRoot)) {
        // Only session owner can respond
        if (session.isUserAllowedInSession(threadRoot, username)) {
          const handled = await session.handleWorktreeBranchResponse(
            threadRoot,
            content,
            username,
            post.id
          );
          if (handled) return;
        }
      }

      // Check if user is allowed in this session
      if (!session.isUserAllowedInSession(threadRoot, username)) {
        // Request approval for their message
        if (content) await session.requestMessageApproval(threadRoot, username, content);
        return;
      }

      // Get any attached files (images)
      const files = post.metadata?.files;

      if (content || files?.length) {
        // Ack: 👀 = seen/working; swapped to ✅ by the result-event handler.
        void client.addReaction?.(post.id, ACK_SEEN_EMOJI).catch((err) => logSilentError('ack-reaction', err));
        const ackSession = activeSession as { pendingAckPostIds?: string[] };
        ackSession.pendingAckPostIds = [...(ackSession.pendingAckPostIds ?? []), post.id];
        await session.sendFollowUp(threadRoot, content, files, username, user?.displayName);
      }
      return;
    }

    // Check for paused session that can be resumed
    // Use registry to check for persisted session directly
    const hasPausedSession = session.registry.getPersistedByThreadId(threadRoot) !== undefined;
    if (hasPausedSession) {
      // If message starts with @mention to someone else, ignore it (side conversation)
      const mentionMatch = message.trim().match(/^@([\w.-]+)/);
      if (mentionMatch && mentionMatch[1].toLowerCase() !== client.getBotName().toLowerCase()) {
        return; // Side conversation, don't interrupt
      }

      const content = client.isBotMentioned(message)
        ? client.extractPrompt(message)
        : message.trim();

      // Parse commands even for paused sessions - !stop should cancel, not resume
      const pausedParsed = parseCommand(content);
      if (pausedParsed) {
        if (pausedParsed.command === 'stop') {
          // Clean up the paused session instead of resuming it
          const persistedSession = session.getPersistedSession(threadRoot);
          if (persistedSession) {
            const allowedUsers = new Set(persistedSession.sessionAllowedUsers);
            if (allowedUsers.has(username) || client.isUserAllowed(username)) {
              session.cancelPausedSession(threadRoot);
              await client.createPost(
                `🛑 ${formatter.formatBold('Session cancelled')} by ${formatter.formatUserMention(username)}`,
                threadRoot
              );
            }
          }
          return;
        }
        // Other commands are consumed (not passed as prompts) — but never
        // silently: an unexplained dead command here reads as a dead bot.
        if (client.isUserAllowed(username)) {
          await client.createPost(
            `ℹ️ This session is paused — only ${formatter.formatCode('!stop')} works right now. Send a regular message to resume it first.`,
            directReplyTo
          );
        }
        return;
      }

      // Check if user is allowed in the paused session
      const persistedSession = session.getPersistedSession(threadRoot);
      if (persistedSession) {
        const allowedUsers = new Set(persistedSession.sessionAllowedUsers);
        if (!allowedUsers.has(username) && !client.isUserAllowed(username)) {
          // Not allowed - could request approval but that would require the session to be active
          await client.createPost(
            `⚠️ ${formatter.formatUserMention(username)} is not authorized to resume this session`,
            threadRoot
          );
          return;
        }
      }

      // Get any attached files (images)
      const files = post.metadata?.files;

      if (content || files?.length) {
        void client.addReaction?.(post.id, ACK_SEEN_EMOJI).catch((err) => logSilentError('ack-reaction', err));
        await session.resumePausedSession(threadRoot, content, files, username);
      } else if (client.isBotMentioned(message)) {
        // Bare @mention at a paused session: answer instead of going silent.
        await client.createPost(
          `Mention me with your request to resume this session`,
          directReplyTo
        );
      }
      return;
    }

    // New session requires @mention
    if (!client.isBotMentioned(message)) return;

    if (!client.isUserAllowed(username)) {
      await client.createPost(`⚠️ ${formatter.formatUserMention(username)} is not authorized`, directReplyTo);
      return;
    }

    let prompt = client.extractPrompt(message);
    const files = post.metadata?.files;

    if (!prompt && !files?.length) {
      await client.createPost(`Mention me with your request`, directReplyTo);
      return;
    }

    // ---------------------------------------------------------------------------
    // Parse and handle commands that work in the first message
    // Uses unified command executor with stacking support
    // ---------------------------------------------------------------------------
    const initialOptions: InitialSessionOptions = {};
    // Foreign channel (allChannels): record where the mention landed so the
    // MCP permission child posts prompts there. (Channel-mode sessions get
    // it from `channelMode.channelId`; this covers `!thread` sessions
    // outside the home channel, where `channelMode` is cleared below.)
    // Home-channel sessions omit it and fall back to the configured
    // channelId, preserving the back-compat shape of Session.
    if (post.channelId !== client.getHomeChannelId()) {
      initialOptions.originChannelId = post.channelId;
    }
    // Channel-mode start: the @mention landed at channel root, so the new
    // session is shared across the whole channel.
    if (isChannelPost) {
      initialOptions.channelMode = { channelId: post.channelId };
    }
    let worktreeBranch: string | undefined;

    // Build executor context for first-message commands
    const ctx: CommandExecutorContext = {
      commandContext: 'first-message',
      threadId: threadRoot,
      replyTo: directReplyTo,
      triggeringPostId: post.id,
      username,
      client,
      sessionManager: session,
      formatter,
      isAllowed: true, // Already verified authorization above
      files,
    };

    // Process commands that can appear at the start of the first message
    let continueProcessing = true;
    while (continueProcessing) {
      continueProcessing = false;

      // Try to parse a first-message command
      const parsed = parseCommandWithRemainder(prompt);
      if (!parsed) break;

      // Check if this command works in first message
      const cmdDef = COMMAND_REGISTRY.find(c => c.command === parsed.command);
      if (!cmdDef?.worksInFirstMessage) break;

      // Execute the command
      const result = await executeCommand(parsed.command, parsed.args, ctx);

      // If command fully handled (immediate commands like !help), we're done
      if (result.handled) {
        return;
      }

      // Apply any session options from the command
      if (result.sessionOptions) {
        Object.assign(initialOptions, result.sessionOptions);
      }

      // Set worktree branch if returned
      if (result.worktreeBranch) {
        worktreeBranch = result.worktreeBranch;
      }

      // Use remainder text for next iteration or as final prompt
      // For worktree branch creation, use remainingText if provided
      if (result.remainingText !== undefined) {
        prompt = result.remainingText;
      } else if (parsed.remainder !== undefined) {
        prompt = parsed.remainder;
      } else {
        prompt = '';
      }

      // Continue if this is a stackable command with more text to process
      continueProcessing = !!prompt && (cmdDef.isStackable || result.continueProcessing === true);
    }

    // Check for inline branch syntax: "on branch X" (legacy support)
    if (!worktreeBranch) {
      const branchMatch = prompt.match(/on branch\s+(\S+)/i);
      if (branchMatch) {
        worktreeBranch = branchMatch[1];
        prompt = prompt.replace(/on branch\s+\S+/i, '').trim();
      }
    }

    // !thread opt-out wiring. The handler in `commands/executor.ts` only
    // sets `forceThreadMode`; the routing decisions live here because
    // `threadRoot` / `channelMode` are message-handler concepts.
    //   - Channel root + !thread → clear channelMode, re-anchor the
    //     session at post.id so my replies thread off the @mention.
    //   - Inside a thread + !thread → no-op (we're already thread-mode);
    //     post a friendly hint so the user knows the command was redundant
    //     but otherwise proceed normally.
    let effectiveThreadRoot = threadRoot;
    if (initialOptions.forceThreadMode) {
      if (isChannelPost) {
        // Platforms with real thread CHANNELS (Discord): create the native
        // thread off the @mention and run a channel-mode session inside it.
        // Reply-threading platforms (Mattermost/Slack): anchor a thread-mode
        // session at the @mention post (channelMode cleared).
        if (client.createThread) {
          const nativeThread = await client.createThread(post.channelId, post.id, 'Claude session');
          if ('error' in nativeThread) {
            // No reply-threading fallback here: on native-thread platforms a
            // session anchored at a post id can't post anywhere. Fail loudly.
            await client.createPost(
              `⚠️ Couldn't start a thread session: ${nativeThread.error}`,
              directReplyTo,
            );
            return;
          }
          initialOptions.channelMode = { channelId: nativeThread.id };
          initialOptions.originChannelId = nativeThread.id;
          effectiveThreadRoot = nativeThread.id;
        } else {
          initialOptions.channelMode = undefined;
          effectiveThreadRoot = post.id;
        }
        // `!thread ... -history`: the flag rides in the remainder (the
        // !thread stackable pattern has no arg group), so it lands in the
        // prompt. Strip the standalone token and seed the session with the
        // recent channel conversation.
        if (/(^|\s)--?history(?=\s|$)/i.test(prompt)) {
          prompt = prompt.replace(/(^|\s)--?history(?=\s|$)/gi, '$1').replace(/[ \t]{2,}/g, ' ').trim();
          if (!prompt) {
            prompt =
              'The user opened a fresh thread session from the channel. Briefly confirm you are ready and ask what they want to work on.';
          }
          const historyContext = await buildChannelHistoryContext(client, post.id, post.channelId);
          if (historyContext) prompt = `${historyContext}${prompt}`;
        }
      } else {
        await client.createPost(
          `ℹ️ ${formatter.formatCode('!thread')} is a no-op inside a thread — sessions started here are already thread-mode.`,
          directReplyTo,
        );
      }
    }

    // If no prompt remains and no files and no worktree, don't start session
    // But if we have a worktree branch, we can start session with empty prompt
    if (!prompt.trim() && !files?.length && !worktreeBranch) {
      // Options were set but no actual prompt - could optionally start session anyway
      // For now, require a prompt or files (unless worktree specified)
      await client.createPost(`Mention me with your request`, directReplyTo);
      return;
    }

    // Ack the @mention that starts the session: 👀 = seen/working. The
    // lifecycle seeds pendingAckPostIds from triggeringPostId so the
    // result-event handler swaps this to ✅ when the first turn completes.
    void client.addReaction?.(post.id, ACK_SEEN_EMOJI).catch((err) => logSilentError('ack-reaction', err));

    // Start session with worktree if branch specified
    if (worktreeBranch) {
      await session.startSessionWithWorktree(
        { prompt, files },
        worktreeBranch,
        username,
        effectiveThreadRoot,
        platformId,
        user?.displayName,
        post.id,  // triggeringPostId
        initialOptions
      );
      return;
    }

    await session.startSession(
      { prompt, files },
      username,
      effectiveThreadRoot,
      platformId,
      user?.displayName,
      post.id,  // triggeringPostId - the actual message that started the session
      initialOptions
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger?.error(`Error handling message: ${errorMessage}`);
    // Try to notify user if possible
    try {
      await client.createPost(`⚠️ An error occurred: ${errorMessage}`, directReplyTo);
    } catch (postErr) {
      logSilentError('error-notification-post', postErr);
    }
  }
}
