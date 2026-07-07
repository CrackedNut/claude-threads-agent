/**
 * Tests for events.ts - Pre/post processing and session-specific side effects
 *
 * NOTE: Main event handling (formatting, tool handling) is now tested in
 * src/operations/ tests. This file tests session-specific side effects that
 * wrap the MessageManager.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  handleEventPreProcessing,
  handleEventPostProcessing,
} from './handler.js';
import type { SessionContext } from '../session-context/index.js';
import type { Session } from '../../session/types.js';
import { createSessionTimers, createSessionLifecycle } from '../../session/types.js';
import type { PlatformClient, PlatformPost } from '../../platform/index.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';

// Mock platform client
function createMockPlatform() {
  const posts: Map<string, string> = new Map();
  let postIdCounter = 1;

  const mockPlatform = {
    getBotUser: mock(async () => ({
      id: 'bot',
      username: 'bot',
      displayName: 'Bot',
    })),
    createPost: mock(async (message: string, _threadId?: string): Promise<PlatformPost> => {
      const id = `post_${postIdCounter++}`;
      posts.set(id, message);
      return {
        id,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: _threadId || '',
        createAt: Date.now(),
      };
    }),
    updatePost: mock(async (postId: string, message: string): Promise<PlatformPost> => {
      posts.set(postId, message);
      return {
        id: postId,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: '',
        createAt: Date.now(),
      };
    }),
    deletePost: mock(async (postId: string): Promise<void> => {
      posts.delete(postId);
    }),
    createInteractivePost: mock(async (message: string, _reactions: string[], _threadId?: string): Promise<PlatformPost> => {
      const id = `post_${postIdCounter++}`;
      posts.set(id, message);
      return {
        id,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: _threadId || '',
        createAt: Date.now(),
      };
    }),
    pinPost: mock(async (_postId: string): Promise<void> => {}),
    unpinPost: mock(async (_postId: string): Promise<void> => {}),
    sendTyping: mock(() => {}),
    getFormatter: () => createMockFormatter(),
    getThreadHistory: mock(async (_threadId: string, _options?: { limit?: number }) => {
      return [];
    }),
    posts,
  };

  return mockPlatform as unknown as PlatformClient & { posts: Map<string, string> };
}

// Create a minimal session for testing
function createTestSession(platform: PlatformClient): Session {
  return {
    platformId: 'test',
    threadId: 'thread1',
    sessionId: 'test:thread1',
    claudeSessionId: 'uuid-123',
    startedBy: 'testuser',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    platform,
    workingDir: '/test',
    claude: {
      isRunning: () => true,
      sendMessage: mock(() => {}),
      getStatusData: () => null,
    } as any,
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    sessionStartPostId: 'start_post',
    sessionHeaderMode: 'full',
    timers: createSessionTimers(),
    lifecycle: createSessionLifecycle(),
    timeoutWarningPosted: false,
    messageCount: 0,
    isProcessing: false,
    recentEvents: [],
    messageManager: undefined,
  };
}

function createSessionContext(): SessionContext {
  return {
    config: {
      debug: false,
      workingDir: '/test',
      permissionMode: 'bypass',
      chromeEnabled: false,
      maxSessions: 5,
    },
    state: {
      sessions: new Map(),
      postIndex: new Map(),
      platforms: new Map(),
      sessionStore: { save: () => {}, remove: () => {}, load: () => new Map(), findByPostId: () => undefined, cleanStale: () => [] } as any,
      githubEmailsStore: { get: () => undefined, set: () => {}, delete: () => false } as any,
      isShuttingDown: false,
    },
    ops: {
      getSessionId: (_p, t) => t,
      findSessionByThreadId: () => undefined,
      registerPost: mock((_postId: string, _threadId: string) => {}),
      flush: mock(async (_session: Session) => {}),
      startTyping: mock((_session: Session) => {}),
      stopTyping: mock((_session: Session) => {}),
      updateStickyMessage: mock(async () => {}),
      persistSession: mock((_session: Session) => {}),
      updateSessionHeader: mock(async (_session: Session) => {}),
      unpersistSession: mock((_sessionId: string) => {}),
      setDefaultModel: mock(() => {}),
      buildMessageContent: mock(async (text: string) => ({ content: text, skipped: [] })),
      handleEvent: mock((_sessionId: string, _event: any) => {}),
      handleExit: mock(async (_sessionId: string, _code: number) => {}),
      killSession: mock(async (_threadId: string) => {}),
      shouldPromptForWorktree: mock(async (_session: Session) => null),
      postWorktreePrompt: mock(async (_session: Session, _reason: string) => {}),
      offerContextPrompt: mock(async (_session: Session, _queuedPrompt: string) => false),
      emitSessionAdd: mock(() => {}),
      emitSessionUpdate: mock(() => {}),
      emitSessionRemove: mock(() => {}),
      registerWorktreeUser: mock(() => {}),
      unregisterWorktreeUser: mock(() => {}),
      hasOtherSessionsUsingWorktree: mock(() => false),
      switchToWorktree: mock(async () => {}),
      forceUpdate: mock(async () => {}),
      deferUpdate: mock(() => {}),
      handleBugReportApproval: mock(async () => {}),
      acquireClaudeAccount: mock(() => null),
      getClaudeAccount: mock(() => undefined),
      releaseClaudeAccount: mock(() => {}),
      markClaudeAccountCooling: mock(() => {}),
      getClaudeAccountPoolStatus: mock(() => []),
      getPlatformOverhead: mock(() => ({ sessionHeader: 'full' as const, stickyMessage: 'full' as const })),
    },
  };
}

describe('handleEventPreProcessing', () => {
  let platform: PlatformClient;
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createSessionContext();
  });

  test('resets session activity on any event', () => {
    const oldTime = new Date(Date.now() - 10000);
    session.lastActivityAt = oldTime;

    handleEventPreProcessing(session, { type: 'assistant' }, ctx);

    expect(session.lastActivityAt.getTime()).toBeGreaterThan(oldTime.getTime());
  });

  test('sets hasClaudeResponded on first assistant event', () => {
    expect(session.lifecycle.hasClaudeResponded).toBe(false);

    handleEventPreProcessing(session, { type: 'assistant' }, ctx);

    expect(session.lifecycle.hasClaudeResponded).toBe(true);
    expect(ctx.ops.persistSession).toHaveBeenCalled();
  });

  test('sets hasClaudeResponded on first tool_use event', () => {
    expect(session.lifecycle.hasClaudeResponded).toBe(false);

    handleEventPreProcessing(session, { type: 'tool_use', tool_use: { name: 'Read' } }, ctx);

    expect(session.lifecycle.hasClaudeResponded).toBe(true);
  });

  test('does not set hasClaudeResponded again if already set', () => {
    session.lifecycle.hasClaudeResponded = true;
    const callCount = (ctx.ops.persistSession as ReturnType<typeof mock>).mock.calls.length;

    handleEventPreProcessing(session, { type: 'assistant' }, ctx);

    // Should not persist again
    expect((ctx.ops.persistSession as ReturnType<typeof mock>).mock.calls.length).toBe(callCount);
  });

  test('captures slash_commands from init event', () => {
    expect(session.availableSlashCommands).toBeUndefined();

    const initEvent = {
      type: 'system',
      subtype: 'init',
      slash_commands: ['compact', 'context', 'cost', 'init', 'review', 'security-review'],
    };

    handleEventPreProcessing(session, initEvent, ctx);

    expect(session.availableSlashCommands).toBeDefined();
    expect(session.availableSlashCommands?.size).toBe(6);
    expect(session.availableSlashCommands?.has('compact')).toBe(true);
    expect(session.availableSlashCommands?.has('review')).toBe(true);
  });

  test('handles slash_commands with leading slashes', () => {
    const initEvent = {
      type: 'system',
      subtype: 'init',
      slash_commands: ['/compact', '/context', '/cost'],
    };

    handleEventPreProcessing(session, initEvent, ctx);

    expect(session.availableSlashCommands?.size).toBe(3);
    // Leading slashes should be stripped
    expect(session.availableSlashCommands?.has('compact')).toBe(true);
    expect(session.availableSlashCommands?.has('/compact')).toBe(false);
  });

  test('ignores init event without slash_commands', () => {
    const initEvent = {
      type: 'system',
      subtype: 'init',
      // No slash_commands field
    };

    handleEventPreProcessing(session, initEvent, ctx);

    expect(session.availableSlashCommands).toBeUndefined();
  });
});

describe('handleEventPostProcessing', () => {
  let platform: PlatformClient;
  let session: Session;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createSessionContext();
  });

  test('stops typing on result event', () => {
    handleEventPostProcessing(session, { type: 'result' }, ctx);

    expect(ctx.ops.stopTyping).toHaveBeenCalled();
    expect(session.isProcessing).toBe(false);
  });

  test('extracts PR URL from assistant text', () => {
    const event = {
      type: 'assistant' as const,
      message: {
        content: [{
          type: 'text',
          text: 'Created PR: https://github.com/user/repo/pull/123',
        }],
      },
    };

    handleEventPostProcessing(session, event, ctx);

    expect(session.pullRequestUrl).toBe('https://github.com/user/repo/pull/123');
    expect(ctx.ops.persistSession).toHaveBeenCalled();
  });

  test('does not overwrite existing PR URL', () => {
    session.pullRequestUrl = 'https://github.com/user/repo/pull/100';

    const event = {
      type: 'assistant' as const,
      message: {
        content: [{
          type: 'text',
          text: 'Created PR: https://github.com/user/repo/pull/200',
        }],
      },
    };

    handleEventPostProcessing(session, event, ctx);

    expect(session.pullRequestUrl).toBe('https://github.com/user/repo/pull/100');
  });

  // NOTE: Subagent toggle reaction tests have been moved to subagent.test.ts
  // since that functionality is now handled by SubagentExecutor via MessageManager

  // NOTE: postCurrentQuestion tests have been removed - question posting now
  // goes through QuestionApprovalExecutor via MessageManager

  test('flushes queued user messages on result event', async () => {
    const handleUserMessage = mock(() => Promise.resolve(true));
    session.messageManager = {
      ...(session.messageManager ?? {}),
      handleUserMessage,
    } as unknown as typeof session.messageManager;
    session.queuedUserMessages = ['first', 'STEER: pivot'];

    handleEventPostProcessing(session, { type: 'result' }, ctx);

    // Synchronous part: clears the buffer and persists.
    expect(session.queuedUserMessages).toBeUndefined();
    expect(ctx.ops.persistSession).toHaveBeenCalled();

    // Async dispatch: handleUserMessage is called with messages joined by blank lines.
    await new Promise(r => setTimeout(r, 0));
    expect(handleUserMessage).toHaveBeenCalledWith(
      'first\n\nSTEER: pivot',
      undefined,
      session.startedBy,
    );
  });

  test('does not call handleUserMessage when queue is empty', async () => {
    const handleUserMessage = mock(() => Promise.resolve(true));
    session.messageManager = {
      ...(session.messageManager ?? {}),
      handleUserMessage,
    } as unknown as typeof session.messageManager;
    session.queuedUserMessages = undefined;

    handleEventPostProcessing(session, { type: 'result' }, ctx);

    await new Promise(r => setTimeout(r, 0));
    expect(handleUserMessage).not.toHaveBeenCalled();
  });

  test('loop mode: result event without a sentinel auto-continues the session', async () => {
    const handleUserMessage = mock(() => Promise.resolve(true));
    session.messageManager = {
      ...(session.messageManager ?? {}),
      handleUserMessage,
    } as unknown as typeof session.messageManager;
    session.loopState = { goal: 'ship it', iteration: 0, maxTurns: 25 };

    handleEventPostProcessing(session, { type: 'result' }, ctx);

    await new Promise(r => setTimeout(r, 0));
    expect(session.loopState?.iteration).toBe(1);
    expect(handleUserMessage).toHaveBeenCalledTimes(1);
    const [message] = (handleUserMessage as ReturnType<typeof mock>).mock.calls[0];
    expect(message).toContain('LOOP MODE');
    expect(message).toContain('ship it');
  });

  test('loop mode: LOOP_COMPLETE in assistant text disarms at the result boundary', async () => {
    const handleUserMessage = mock(() => Promise.resolve(true));
    session.messageManager = {
      ...(session.messageManager ?? {}),
      handleUserMessage,
    } as unknown as typeof session.messageManager;
    session.loopState = { goal: 'ship it', iteration: 2, maxTurns: 25 };

    handleEventPostProcessing(session, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'All verified.\nLOOP_COMPLETE' }] },
    } as any, ctx);
    expect(session.loopState?.sentinel).toBe('complete');

    handleEventPostProcessing(session, { type: 'result' }, ctx);

    await new Promise(r => setTimeout(r, 0));
    expect(session.loopState).toBeUndefined();
    expect(handleUserMessage).not.toHaveBeenCalled();
  });

  test('loop mode: a flushed !queue message takes the round instead of the loop', async () => {
    const handleUserMessage = mock(() => Promise.resolve(true));
    session.messageManager = {
      ...(session.messageManager ?? {}),
      handleUserMessage,
    } as unknown as typeof session.messageManager;
    session.loopState = { goal: 'ship it', iteration: 1, maxTurns: 25 };
    session.queuedUserMessages = ['check the logs first'];

    handleEventPostProcessing(session, { type: 'result' }, ctx);

    await new Promise(r => setTimeout(r, 0));
    // Only the queued message went out; the loop stayed armed at 1.
    expect(handleUserMessage).toHaveBeenCalledTimes(1);
    expect((handleUserMessage as ReturnType<typeof mock>).mock.calls[0][0]).toBe('check the logs first');
    expect(session.loopState?.iteration).toBe(1);
  });

  // Regression (2026-06-11): `!steer` interrupts Claude, which emits this
  // final `result` and then EXITS. Flushing the queue here would deliver into
  // the dying process and flip the session to 'active', so the exit kills the
  // session instead of pausing it. While interrupted, the queue must be left
  // intact for resume to drain.
  test('does NOT flush the queue on the result emitted during an interrupt', async () => {
    const handleUserMessage = mock(() => Promise.resolve(true));
    session.messageManager = {
      ...(session.messageManager ?? {}),
      handleUserMessage,
    } as unknown as typeof session.messageManager;
    session.queuedUserMessages = ['STEER: pivot'];
    session.lifecycle.state = 'interrupted';

    handleEventPostProcessing(session, { type: 'result' }, ctx);

    // Queue preserved (not cleared), and no delivery into the dying process.
    expect(session.queuedUserMessages).toEqual(['STEER: pivot']);
    await new Promise(r => setTimeout(r, 0));
    expect(handleUserMessage).not.toHaveBeenCalled();
  });
});
