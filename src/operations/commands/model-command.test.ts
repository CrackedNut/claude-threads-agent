/**
 * `!model` picker behavior: the pick changes only THIS session unless the
 * picker was opened with `--default`, in which case it also persists the
 * bot-wide default. The respawn machinery is stubbed (ClaudeCli mocked) so
 * these tests exercise the decision logic without spawning Claude.
 */
import { describe, it, expect, mock } from 'bun:test';
import { EventEmitter } from 'events';

// NOTE: bun's mock.module is process-global, so this MockClaudeCli can leak
// into other test files in the same run. Keep it a COMPLETE stub (matches
// restart-rebind.test.ts) — a partial stub missing e.g. sendMessage breaks
// lifecycle.test.ts when the two run together under --bail.
mock.module('../../claude/cli.js', () => ({
  ClaudeCli: class MockClaudeCli extends EventEmitter {
    isRunning() { return true; }
    kill() { return Promise.resolve(); }
    start() {}
    sendMessage() {}
    interrupt() { return true; }
  },
}));

import { showModelPicker, applyModelPick } from './handler.js';
import { FALLBACK_MODEL_CHOICES } from './models.js';
import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import { createSessionTimers, createSessionLifecycle } from '../../session/types.js';
import { createMockFormatter } from '../../test-utils/mock-formatter.js';

function makeSession(): Session {
  let reactionsAdded: string[] = [];
  const platform = {
    getFormatter: () => createMockFormatter(),
    getMcpConfig: () => ({ type: 'mattermost', url: '', token: '', channelId: '', allowedUsers: [] }),
    isUserAllowed: () => true,
    createInteractivePost: mock((_msg: string, reactions: string[]) => {
      reactionsAdded = reactions;
      return Promise.resolve({ id: 'picker-1', message: _msg, userId: 'bot' });
    }),
    createPost: mock(() => Promise.resolve({ id: 'p', message: '', userId: 'bot' })),
    updatePost: mock(() => Promise.resolve({ id: 'p', message: '', userId: 'bot' })),
    addReaction: mock(() => Promise.resolve()),
  };
  return {
    sessionId: 'test:thread-1',
    platformId: 'test',
    threadId: 'thread-1',
    claudeSessionId: 'uuid-1',
    startedBy: 'alice',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    workingDir: '/tmp',
    claude: new (class extends EventEmitter { isRunning() { return true; } kill() { return Promise.resolve(); } })() as unknown as Session['claude'],
    planApproved: false,
    sessionAllowedUsers: new Set(['alice']),
    forceInteractivePermissions: false,
    sessionStartPostId: null,
    timers: createSessionTimers(),
    lifecycle: createSessionLifecycle(),
    timeoutWarningPosted: false,
    messageCount: 0,
    isProcessing: false,
    platform: platform as unknown as Session['platform'],
    __reactions: () => reactionsAdded,
  } as unknown as Session & { __reactions: () => string[] };
}

function makeCtx() {
  const setDefaultModel = mock((_m: string | null) => {});
  const registerPost = mock((_pid: string, _tid: string) => {});
  const ctx = {
    config: { chromeEnabled: false, permissionMode: 'bypass', permissionTimeoutMs: 1000 },
    state: {},
    ops: {
      stopTyping: mock(() => {}),
      flush: mock(async () => {}),
      handleEvent: mock(() => {}),
      handleExit: mock(async () => {}),
      persistSession: mock(() => {}),
      setDefaultModel,
      registerPost,
      updateSessionHeader: mock(async () => {}),
      emitSessionUpdate: mock(() => {}),
    },
  } as unknown as SessionContext;
  return { ctx, setDefaultModel, registerPost };
}

describe('showModelPicker', () => {
  it('posts the picker with one reaction per model choice and arms the pending pick', async () => {
    const session = makeSession();
    const { ctx } = makeCtx();
    await showModelPicker(session, 'alice', false, ctx);

    expect((session as unknown as { __reactions: () => string[] }).__reactions().length).toBe(FALLBACK_MODEL_CHOICES.length);
    expect(session.pendingModelPick).toEqual({ postId: 'picker-1', setDefault: false, choices: FALLBACK_MODEL_CHOICES });
  });

  it('registers the picker post so reactions on it resolve to the session', async () => {
    const session = makeSession();
    const { ctx, registerPost } = makeCtx();
    await showModelPicker(session, 'alice', false, ctx);
    // Without this the reaction router can't find the session → picks are dropped.
    expect(registerPost).toHaveBeenCalledWith('picker-1', session.threadId);
  });

  it('records setDefault when opened with --default', async () => {
    const session = makeSession();
    const { ctx } = makeCtx();
    await showModelPicker(session, 'alice', true, ctx);
    expect(session.pendingModelPick?.setDefault).toBe(true);
  });
});

describe('applyModelPick', () => {
  it('ignores a reaction on a different post (returns false)', async () => {
    const session = makeSession();
    const { ctx } = makeCtx();
    session.pendingModelPick = { postId: 'picker-1', setDefault: false };
    const handled = await applyModelPick(session, 'some-other-post', 0, 'alice', ctx);
    expect(handled).toBe(false);
    expect(session.pendingModelPick).toBeDefined(); // untouched
  });

  it('sets the session model only (never the default) for a plain pick', async () => {
    const session = makeSession();
    const { ctx, setDefaultModel } = makeCtx();
    session.pendingModelPick = { postId: 'picker-1', setDefault: false };

    const handled = await applyModelPick(session, 'picker-1', 0, 'alice', ctx); // index 0 = Opus
    expect(handled).toBe(true);
    expect(session.modelOverride).toBe(FALLBACK_MODEL_CHOICES[0].value ?? undefined);
    expect(setDefaultModel).not.toHaveBeenCalled();
    expect(session.pendingModelPick).toBeUndefined();
  });

  it('clears the override when "Default (inherit)" is picked', async () => {
    const session = makeSession();
    const { ctx } = makeCtx();
    session.modelOverride = 'opus';
    const inheritIndex = FALLBACK_MODEL_CHOICES.findIndex((m) => m.value === null);
    session.pendingModelPick = { postId: 'picker-1', setDefault: false };

    await applyModelPick(session, 'picker-1', inheritIndex, 'alice', ctx);
    expect(session.modelOverride).toBeUndefined();
  });

  it('also persists the bot-wide default when the picker was --default', async () => {
    const session = makeSession();
    const { ctx, setDefaultModel } = makeCtx();
    session.pendingModelPick = { postId: 'picker-1', setDefault: true };

    await applyModelPick(session, 'picker-1', 1, 'alice', ctx); // index 1 = Sonnet
    expect(setDefaultModel).toHaveBeenCalledWith(FALLBACK_MODEL_CHOICES[1].value);
    expect(session.modelOverride).toBe(FALLBACK_MODEL_CHOICES[1].value ?? undefined);
  });
});
