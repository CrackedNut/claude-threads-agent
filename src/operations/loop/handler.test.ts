/**
 * Loop mode tests — sentinel parsing, the turn-boundary decision
 * (continue / complete / blocked / cap), and arm/stop lifecycle.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  parseLoopArgs,
  scanLoopSentinels,
  maybeContinueLoop,
  armLoop,
  stopLoop,
  withLoopDirective,
  DEFAULT_LOOP_MAX_TURNS,
} from './handler.js';
import type { Session } from '../../session/types.js';
import { createSessionTimers, createSessionLifecycle } from '../../session/types.js';
import type { PlatformClient, PlatformPost } from '../../platform/index.js';
import type { SessionContext } from '../session-context/index.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';

function createMockPlatform() {
  const posts: string[] = [];
  return {
    posts,
    createPost: mock(async (message: string): Promise<PlatformPost> => {
      posts.push(message);
      return {
        id: `post_${posts.length}`,
        platformId: 'test',
        channelId: 'channel1',
        userId: 'bot',
        message,
        rootId: '',
        createAt: Date.now(),
      };
    }),
    getFormatter: () => createMockFormatter(),
  } as unknown as PlatformClient & { posts: string[] };
}

function createTestSession(platform: PlatformClient): Session & {
  sentMessages: string[];
} {
  const sentMessages: string[] = [];
  const session = {
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
    claude: { isRunning: () => true } as any,
    planApproved: false,
    sessionAllowedUsers: new Set(['testuser']),
    forceInteractivePermissions: false,
    sessionStartPostId: 'start_post',
    sessionHeaderMode: 'full' as const,
    timers: createSessionTimers(),
    lifecycle: createSessionLifecycle(),
    timeoutWarningPosted: false,
    messageCount: 0,
    isProcessing: false,
    recentEvents: [],
    messageManager: {
      handleUserMessage: mock(async (message: string) => {
        sentMessages.push(message);
        return true;
      }),
    } as any,
    sentMessages,
  };
  return session as unknown as Session & { sentMessages: string[] };
}

function createCtx(): SessionContext {
  return {
    ops: {
      persistSession: mock((_s: Session) => {}),
    },
  } as unknown as SessionContext;
}

describe('parseLoopArgs', () => {
  test('plain goal gets the default cap', () => {
    expect(parseLoopArgs('ship the feature')).toEqual({
      goal: 'ship the feature',
      maxTurns: DEFAULT_LOOP_MAX_TURNS,
    });
  });

  test('leading integer overrides the cap', () => {
    expect(parseLoopArgs('50 ship the feature')).toEqual({
      goal: 'ship the feature',
      maxTurns: 50,
    });
  });

  test('a goal that merely contains numbers is untouched', () => {
    expect(parseLoopArgs('fix the 3 failing tests').goal).toBe('fix the 3 failing tests');
    expect(parseLoopArgs('fix the 3 failing tests').maxTurns).toBe(DEFAULT_LOOP_MAX_TURNS);
  });
});

describe('scanLoopSentinels', () => {
  test('no-op when no loop is armed', () => {
    const session = createTestSession(createMockPlatform());
    scanLoopSentinels(session, 'all done LOOP_COMPLETE');
    expect(session.loopState).toBeUndefined();
  });

  test('detects LOOP_COMPLETE', () => {
    const session = createTestSession(createMockPlatform());
    session.loopState = { goal: 'g', iteration: 2, maxTurns: 25 };
    scanLoopSentinels(session, 'Everything verified.\nLOOP_COMPLETE');
    expect(session.loopState?.sentinel).toBe('complete');
  });

  test('detects LOOP_BLOCKED and captures the reason', () => {
    const session = createTestSession(createMockPlatform());
    session.loopState = { goal: 'g', iteration: 2, maxTurns: 25 };
    scanLoopSentinels(session, 'LOOP_BLOCKED: need the prod DB password');
    expect(session.loopState?.sentinel).toBe('blocked');
    expect(session.loopState?.blockedReason).toBe('need the prod DB password');
  });

  test('plain text sets nothing', () => {
    const session = createTestSession(createMockPlatform());
    session.loopState = { goal: 'g', iteration: 0, maxTurns: 25 };
    scanLoopSentinels(session, 'still working on the tests');
    expect(session.loopState?.sentinel).toBeUndefined();
  });
});

describe('maybeContinueLoop', () => {
  let platform: ReturnType<typeof createMockPlatform>;
  let session: ReturnType<typeof createTestSession>;
  let ctx: SessionContext;

  beforeEach(() => {
    platform = createMockPlatform();
    session = createTestSession(platform);
    ctx = createCtx();
  });

  test('no-op without an armed loop', async () => {
    await maybeContinueLoop(session, ctx, false);
    expect(session.sentMessages.length).toBe(0);
    expect(platform.posts.length).toBe(0);
  });

  test('continues with the directive when the turn ends without a sentinel', async () => {
    session.loopState = { goal: 'ship it', iteration: 0, maxTurns: 25 };
    await maybeContinueLoop(session, ctx, false);
    expect(session.loopState?.iteration).toBe(1);
    expect(session.sentMessages.length).toBe(1);
    expect(session.sentMessages[0]).toContain('LOOP MODE');
    expect(session.sentMessages[0]).toContain('ship it');
    // Progress note posted to the thread.
    expect(platform.posts.some((p) => p.includes('1/25'))).toBe(true);
  });

  test('LOOP_COMPLETE disarms and celebrates instead of continuing', async () => {
    session.loopState = { goal: 'g', iteration: 3, maxTurns: 25, sentinel: 'complete' };
    await maybeContinueLoop(session, ctx, false);
    expect(session.loopState).toBeUndefined();
    expect(session.sentMessages.length).toBe(0);
    expect(platform.posts.some((p) => p.includes('Loop complete'))).toBe(true);
  });

  test('LOOP_BLOCKED disarms and surfaces the reason', async () => {
    session.loopState = {
      goal: 'g', iteration: 3, maxTurns: 25,
      sentinel: 'blocked', blockedReason: 'need credentials',
    };
    await maybeContinueLoop(session, ctx, false);
    expect(session.loopState).toBeUndefined();
    expect(session.sentMessages.length).toBe(0);
    expect(platform.posts.some((p) => p.includes('need credentials'))).toBe(true);
  });

  test('a flushed !queue message wins the round but the loop stays armed', async () => {
    session.loopState = { goal: 'g', iteration: 1, maxTurns: 25 };
    await maybeContinueLoop(session, ctx, true);
    expect(session.loopState?.iteration).toBe(1); // unchanged
    expect(session.sentMessages.length).toBe(0);
  });

  test('does not stack a continuation onto an already-processing session', async () => {
    session.loopState = { goal: 'g', iteration: 1, maxTurns: 25 };
    session.isProcessing = true;
    await maybeContinueLoop(session, ctx, false);
    expect(session.loopState?.iteration).toBe(1);
    expect(session.sentMessages.length).toBe(0);
  });

  test('cap reached → disarms with a warning, no continuation', async () => {
    session.loopState = { goal: 'g', iteration: 25, maxTurns: 25 };
    await maybeContinueLoop(session, ctx, false);
    expect(session.loopState).toBeUndefined();
    expect(session.sentMessages.length).toBe(0);
    expect(platform.posts.some((p) => p.includes('Loop cap reached'))).toBe(true);
  });

  test('sentinel flags reset on each continuation', async () => {
    session.loopState = { goal: 'g', iteration: 0, maxTurns: 25, blockedReason: 'stale' };
    await maybeContinueLoop(session, ctx, false);
    expect(session.loopState?.sentinel).toBeUndefined();
    expect(session.loopState?.blockedReason).toBeUndefined();
  });
});

describe('armLoop / stopLoop', () => {
  test('arming an idle session sends the goal kick immediately', async () => {
    const platform = createMockPlatform();
    const session = createTestSession(platform);
    const ctx = createCtx();
    await armLoop(session, 'ship it', 10, 'testuser', ctx);
    expect(session.loopState).toEqual({ goal: 'ship it', maxTurns: 10, iteration: 0 });
    expect(session.sentMessages.length).toBe(1);
    expect(session.sentMessages[0]).toBe(withLoopDirective('ship it', session.loopState!));
    expect(platform.posts.some((p) => p.includes('Loop armed'))).toBe(true);
  });

  test('arming a mid-turn session waits for the turn boundary', async () => {
    const platform = createMockPlatform();
    const session = createTestSession(platform);
    session.isProcessing = true;
    await armLoop(session, 'ship it', 10, 'testuser', createCtx());
    expect(session.loopState).toBeDefined();
    expect(session.sentMessages.length).toBe(0);
  });

  test('stopLoop disarms and reports', async () => {
    const platform = createMockPlatform();
    const session = createTestSession(platform);
    session.loopState = { goal: 'g', iteration: 4, maxTurns: 25 };
    await stopLoop(session, 'testuser', createCtx());
    expect(session.loopState).toBeUndefined();
    expect(platform.posts.some((p) => p.includes('Loop disarmed'))).toBe(true);
  });
});
