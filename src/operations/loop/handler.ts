/**
 * Loop mode — autonomous goal loop (`!loop <goal>`).
 *
 * Armed on a session, loop mode keeps Claude working until the goal is done:
 * every time a turn ends WITHOUT the completion sentinel, the bot auto-sends
 * a continuation follow-up. Claude signals the two legitimate exits itself:
 *
 *   - `LOOP_COMPLETE`          — the goal is verified done
 *   - `LOOP_BLOCKED: <reason>` — a genuinely human-only blocker
 *
 * A max-continuation cap (default 25, override `!loop <n> <goal>`) bounds a
 * runaway loop; interactive prompts (permissions, questions) still pause the
 * turn as usual — the loop only acts at turn boundaries (`result` events).
 *
 * Wiring:
 *   - `scanLoopSentinels`  ← assistant-text events (events/handler.ts)
 *   - `maybeContinueLoop`  ← result events, after the `!queue` flush
 *   - arm/stop/status      ← `!loop` command (commands/executor.ts →
 *                            SessionManager → here)
 */

import type { Session, SessionLoopState } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import { post } from '../post-helpers/index.js';
import { createLogger } from '../../utils/logger.js';
import { createSessionLog } from '../../utils/session-log.js';

const log = createLogger('loop');
const sessionLog = createSessionLog(log);

export const DEFAULT_LOOP_MAX_TURNS = 25;
export const LOOP_COMPLETE_SENTINEL = 'LOOP_COMPLETE';
export const LOOP_BLOCKED_SENTINEL = 'LOOP_BLOCKED';

/** `!loop 50 build the thing` → maxTurns 50, goal "build the thing". */
export function parseLoopArgs(args: string): { goal: string; maxTurns: number } {
  const m = args.trim().match(/^(\d{1,3})\s+(.+)$/s);
  if (m) {
    return { goal: m[2].trim(), maxTurns: Math.max(1, parseInt(m[1], 10)) };
  }
  return { goal: args.trim(), maxTurns: DEFAULT_LOOP_MAX_TURNS };
}

/**
 * The autonomy contract, attached to the initial goal message and repeated
 * on every continuation so it survives context compaction.
 */
export function buildLoopDirective(state: SessionLoopState): string {
  return (
    `[LOOP MODE — turn ${state.iteration + 1}, max ${state.maxTurns} auto-continues]\n` +
    `Goal: ${state.goal}\n` +
    `Work autonomously until the goal is COMPLETE. Do not stop to ask for ` +
    `clarification, confirmation, or preferences — decide with your best ` +
    `judgment and keep going. Asking the user is only acceptable for a ` +
    `blocker no amount of judgment can resolve (missing credentials, a ` +
    `destructive/irreversible choice, an external dependency only they ` +
    `control).\n` +
    `When the goal is fully done AND verified, end your message with the ` +
    `word ${LOOP_COMPLETE_SENTINEL} on its own line. If you hit a genuinely ` +
    `human-only blocker, end with ${LOOP_BLOCKED_SENTINEL}: <one-line reason>. ` +
    `Never output either token otherwise.`
  );
}

/** Wrap the initial goal prompt with the loop directive. */
export function withLoopDirective(prompt: string, state: SessionLoopState): string {
  return `${buildLoopDirective(state)}\n\n${prompt}`;
}

/**
 * Scan a chunk of Claude's output for the exit sentinels. Called per
 * assistant-text block, so the flag accumulates across a streamed turn and
 * `maybeContinueLoop` reads it at the turn boundary.
 */
export function scanLoopSentinels(session: Session, text: string): void {
  const state = session.loopState;
  if (!state) return;
  if (text.includes(LOOP_COMPLETE_SENTINEL)) {
    state.sentinel = 'complete';
    return;
  }
  const blocked = text.match(new RegExp(`${LOOP_BLOCKED_SENTINEL}:?\\s*(.{0,200})`));
  if (blocked) {
    state.sentinel = 'blocked';
    state.blockedReason = blocked[1]?.trim() || undefined;
  }
}

/**
 * Turn-boundary hook: decide whether the loop continues, completes, or caps.
 *
 * `queueFlushed` — a `!queue`/`!steer` message was just delivered as the
 * next turn; the loop stays armed but must not double-send this round.
 */
export async function maybeContinueLoop(
  session: Session,
  ctx: SessionContext,
  queueFlushed: boolean,
): Promise<void> {
  const state = session.loopState;
  if (!state) return;
  const formatter = session.platform.getFormatter();

  if (state.sentinel === 'complete') {
    session.loopState = undefined;
    ctx.ops.persistSession(session);
    sessionLog(session).info(`🔁 Loop complete after ${state.iteration} auto-continue(s)`);
    await post(
      session,
      'info',
      `✅ ${formatter.formatBold('Loop complete')} — goal reached after ${state.iteration} auto-continue${state.iteration === 1 ? '' : 's'}.`,
    );
    return;
  }

  if (state.sentinel === 'blocked') {
    session.loopState = undefined;
    ctx.ops.persistSession(session);
    sessionLog(session).info(`🔁 Loop blocked after ${state.iteration} auto-continue(s): ${state.blockedReason ?? 'no reason given'}`);
    await post(
      session,
      'warning',
      `🛑 ${formatter.formatBold('Loop blocked')} — Claude reports a human-only blocker` +
        (state.blockedReason ? `: ${state.blockedReason}` : '.'),
    );
    return;
  }

  // A queued user message just went out as the next turn — let it run; the
  // loop re-evaluates at that turn's result.
  if (queueFlushed) return;

  // Something else already started a new turn (e.g. a user follow-up raced
  // the result event). Don't stack a second in-flight message.
  if (session.isProcessing) return;

  if (state.iteration >= state.maxTurns) {
    session.loopState = undefined;
    ctx.ops.persistSession(session);
    sessionLog(session).info(`🔁 Loop cap hit (${state.maxTurns})`);
    await post(
      session,
      'warning',
      `⏹️ ${formatter.formatBold('Loop cap reached')} (${state.maxTurns} auto-continues) — goal not confirmed complete. ` +
        `Re-arm with ${formatter.formatCode('!loop <goal>')} to keep going.`,
    );
    return;
  }

  state.iteration++;
  state.sentinel = undefined;
  state.blockedReason = undefined;
  ctx.ops.persistSession(session);
  sessionLog(session).info(`🔁 Loop auto-continue ${state.iteration}/${state.maxTurns}`);
  await post(
    session,
    'info',
    `🔁 ${formatter.formatItalic(`Loop ${state.iteration}/${state.maxTurns} — continuing…`)}`,
  );
  const continued = await session.messageManager?.handleUserMessage(
    `${buildLoopDirective(state)}\n\nThe goal is not yet confirmed complete. Continue.`,
    undefined,
    session.startedBy,
  );
  if (!continued) {
    // Claude isn't running (paused/exiting). Leave the loop armed — resume
    // restores loopState and the next turn boundary picks it back up.
    sessionLog(session).info('🔁 Loop continuation skipped — Claude not running (stays armed for resume)');
  }
}

/**
 * Arm loop mode on a running session (`!loop <goal>` in-session).
 * Idle Claude gets the goal kick immediately; mid-turn arming waits for the
 * current turn's result.
 */
export async function armLoop(
  session: Session,
  goal: string,
  maxTurns: number,
  username: string,
  ctx: SessionContext,
): Promise<void> {
  session.threadLogger?.logCommand('loop', goal.slice(0, 80), username);
  const formatter = session.platform.getFormatter();
  session.loopState = { goal, maxTurns, iteration: 0 };
  ctx.ops.persistSession(session);
  sessionLog(session).info(`🔁 Loop armed by @${username}: "${goal.slice(0, 60)}" (max ${maxTurns})`);
  await post(
    session,
    'info',
    `🔁 ${formatter.formatBold('Loop armed')} by ${formatter.formatUserMention(username)} — ` +
      `${formatter.formatItalic(goal)} (max ${maxTurns} auto-continues; ${formatter.formatCode('!loop stop')} to disarm).`,
  );

  if (session.claude.isRunning() && !session.isProcessing) {
    await session.messageManager?.handleUserMessage(
      withLoopDirective(goal, session.loopState),
      undefined,
      username,
    );
  }
  // Mid-turn: the directive + goal go out at the next turn boundary via
  // maybeContinueLoop (counts as the first auto-continue).
}

/** Disarm loop mode (`!loop stop`). */
export async function stopLoop(session: Session, username: string, ctx: SessionContext): Promise<void> {
  const formatter = session.platform.getFormatter();
  if (!session.loopState) {
    await post(session, 'info', `ℹ️ No loop armed on this session.`);
    return;
  }
  const { iteration, maxTurns } = session.loopState;
  session.loopState = undefined;
  ctx.ops.persistSession(session);
  session.threadLogger?.logCommand('loop', 'stop', username);
  sessionLog(session).info(`🔁 Loop disarmed by @${username} at ${iteration}/${maxTurns}`);
  await post(
    session,
    'info',
    `⏹️ ${formatter.formatBold('Loop disarmed')} by ${formatter.formatUserMention(username)} (was ${iteration}/${maxTurns}).`,
  );
}

/** Report loop state (`!loop status`). */
export async function loopStatus(session: Session): Promise<void> {
  const formatter = session.platform.getFormatter();
  const state = session.loopState;
  if (!state) {
    await post(session, 'info', `ℹ️ No loop armed. Start one with ${formatter.formatCode('!loop <goal>')}.`);
    return;
  }
  await post(
    session,
    'info',
    `🔁 ${formatter.formatBold('Loop active')} — ${state.iteration}/${state.maxTurns} auto-continues used.\n` +
      `Goal: ${formatter.formatItalic(state.goal)}`,
  );
}
