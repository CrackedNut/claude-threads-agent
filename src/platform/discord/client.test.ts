/**
 * Discord client unit tests — the pure mapping logic (mention matching, the
 * channel-mode normalization, DM mention-injection, config). The gateway
 * itself is discord.js's job and isn't exercised here.
 */
import { describe, it, expect } from 'bun:test';
import { ChannelType } from 'discord.js';
import { DiscordClient } from './client.js';
import type { DiscordPlatformConfig } from '../../config/index.js';

function makeClient(overrides: Partial<DiscordPlatformConfig> = {}): DiscordClient {
  const config: DiscordPlatformConfig = {
    id: 'discord-main',
    type: 'discord',
    displayName: 'Test',
    token: 'bot-token',
    channelId: 'home-channel-123',
    botName: 'claude',
    allowedUsers: ['alice'],
    ...overrides,
  };
  const c = new DiscordClient(config);
  // Pretend the gateway handshake set our identity.
  (c as unknown as { botUserId: string }).botUserId = 'bot-999';
  (c as unknown as { botUsername: string }).botUsername = 'claude';
  return c;
}

// Minimal Message-like fixture for the private normalizer.
function fakeMessage(opts: {
  id?: string;
  channelId: string;
  channelType?: ChannelType;
  authorId?: string;
  content: string;
  attachments?: Array<{ id: string; name: string; size: number; contentType?: string; url?: string }>;
  threadParentId?: string; // makes the channel a native thread of this parent
}) {
  const atts = new Map((opts.attachments ?? []).map((a) => [a.id, a]));
  const channel: Record<string, unknown> = {
    id: opts.channelId,
    type: opts.channelType ?? ChannelType.GuildText,
  };
  if (opts.threadParentId !== undefined) {
    channel.type = opts.channelType ?? ChannelType.PublicThread;
    channel.isThread = () => true;
    channel.parentId = opts.threadParentId;
  }
  return {
    id: opts.id ?? 'msg-1',
    channel,
    author: { id: opts.authorId ?? 'user-1', username: 'alice', bot: false },
    content: opts.content,
    createdTimestamp: 1000,
    system: false,
    attachments: { size: atts.size, values: () => atts.values() },
  };
}

describe('DiscordClient login error guidance', () => {
  const explain = (c: DiscordClient, e: unknown) =>
    (c as unknown as { explainLoginError: (e: unknown) => Error }).explainLoginError(e);

  it('rewrites "disallowed intents" into the MESSAGE CONTENT toggle steps', () => {
    const out = explain(makeClient(), new Error('Used disallowed intents'));
    expect(out.message).toContain('MESSAGE CONTENT');
    expect(out.message).toContain('Privileged Gateway Intents');
  });

  it('rewrites an invalid-token error into a reset hint', () => {
    const out = explain(makeClient(), new Error('An invalid token was provided'));
    expect(out.message).toContain('Reset it');
  });

  it('passes other errors through unchanged', () => {
    const out = explain(makeClient(), new Error('network unreachable'));
    expect(out.message).toBe('network unreachable');
  });
});

// Wire a fake discord.js Client exposing one resolvable guild channel.
function withFakeGateway(
  c: DiscordClient,
  channel: Record<string, unknown>,
): void {
  (c as unknown as { client: unknown }).client = {
    user: { id: 'bot-999' },
    channels: {
      cache: new Map(),
      fetch: async () => ({ isTextBased: () => true, ...channel }),
    },
  };
}

function fakeGuildChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chan-1',
    threads: {},
    messages: {
      fetch: async () => ({
        startThread: async () => ({ id: 'thread-77' }),
      }),
    },
    permissionsFor: () => ({ has: () => true }),
    ...overrides,
  };
}

describe('DiscordClient createThread', () => {
  it('returns an error (not throw) when there is no live gateway client', async () => {
    const c = makeClient();
    const res = await c.createThread('chan-1', 'msg-1', 'topic');
    expect(res && 'error' in res).toBe(true);
  });

  it('creates the thread when all permissions are granted', async () => {
    const c = makeClient();
    withFakeGateway(c, fakeGuildChannel());
    const res = await c.createThread('chan-1', 'msg-1', 'topic');
    expect(res).toEqual({ id: 'thread-77' });
  });

  it('refuses with the exact missing permission instead of creating a thread it cannot post in', async () => {
    // "Send Messages in Threads" is a SEPARATE grant from "Send Messages":
    // without the pre-flight the thread gets created and every post inside
    // 403s — the silent-!thread bug.
    const { PermissionFlagsBits } = await import('discord.js');
    const c = makeClient();
    let threadCreated = false;
    withFakeGateway(
      c,
      fakeGuildChannel({
        permissionsFor: () => ({
          has: (flag: bigint) => flag !== PermissionFlagsBits.SendMessagesInThreads,
        }),
        messages: {
          fetch: async () => ({
            startThread: async () => {
              threadCreated = true;
              return { id: 'thread-77' };
            },
          }),
        },
      }),
    );
    const res = await c.createThread('chan-1', 'msg-1', 'topic');
    expect(res && 'error' in res && res.error).toContain('Send Messages in Threads');
    expect(threadCreated).toBe(false);
  });

  it('refuses in channels without thread support (DMs)', async () => {
    const c = makeClient();
    withFakeGateway(c, { id: 'dm-1', messages: { fetch: async () => ({}) } }); // no `threads`
    const res = await c.createThread('dm-1', 'msg-1', 'topic');
    expect(res && 'error' in res && res.error).toContain('does not support threads');
  });
});

describe('DiscordClient identity & config', () => {
  it('reports the home channel and discord mcp config', () => {
    const c = makeClient();
    expect(c.getHomeChannelId()).toBe('home-channel-123');
    expect(c.platformType).toBe('discord');
    const mcp = c.getMcpConfig();
    expect(mcp.type).toBe('discord');
    expect(mcp.token).toBe('bot-token');
    expect(mcp.channelId).toBe('home-channel-123');
    expect(mcp.allowedUsers).toEqual(['alice']);
  });

  it('uses Discord 2000-char message limits', () => {
    expect(makeClient().getMessageLimits()).toEqual({ maxLength: 2000, hardThreshold: 1900 });
  });

  it('builds a guild message permalink', () => {
    const c = makeClient();
    expect(c.getThreadLink('chan-1', 'msg-5')).toBe('https://discord.com/channels/@me/chan-1/msg-5');
  });
});

describe('DiscordClient mention matching', () => {
  it('matches <@id> and <@!id> for the bot', () => {
    const c = makeClient();
    expect(c.isBotMentioned('hey <@bot-999> do x')).toBe(true);
    expect(c.isBotMentioned('hey <@!bot-999> do x')).toBe(true);
    expect(c.isBotMentioned('hey <@someone-else> do x')).toBe(false);
    expect(c.isBotMentioned('no mention')).toBe(false);
  });

  it('strips the bot mention from the prompt', () => {
    const c = makeClient();
    expect(c.extractPrompt('<@bot-999> build it')).toBe('build it');
    expect(c.extractPrompt('build it <@!bot-999>')).toBe('build it');
  });
});

describe('DiscordClient normalization (channel-mode model)', () => {
  it('normalizes a guild message with rootId undefined (every channel is channel-mode)', () => {
    const c = makeClient();
    const post = (c as unknown as { normalizePost: (m: unknown, dm: boolean) => unknown }).normalizePost(
      fakeMessage({ channelId: 'chan-7', content: 'hello' }),
      false,
    ) as { channelId: string; rootId?: string; message: string; userId: string };
    expect(post.channelId).toBe('chan-7');
    expect(post.rootId).toBeUndefined();
    expect(post.message).toBe('hello');
  });

  it('injects the bot mention into DM content so DMs need no explicit @mention', () => {
    const c = makeClient();
    const post = (c as unknown as { normalizePost: (m: unknown, dm: boolean) => unknown }).normalizePost(
      fakeMessage({ channelId: 'dm-1', channelType: ChannelType.DM, content: 'hi there' }),
      true,
    ) as { message: string };
    expect(post.message).toBe('<@bot-999> hi there');
    expect(c.isBotMentioned(post.message)).toBe(true);
  });

  it('maps attachments into platform files', () => {
    const c = makeClient();
    const post = (c as unknown as { normalizePost: (m: unknown, dm: boolean) => unknown }).normalizePost(
      fakeMessage({
        channelId: 'chan-7',
        content: 'see file',
        attachments: [{ id: 'f1', name: 'log.txt', size: 12, contentType: 'text/plain' }],
      }),
      false,
    ) as { metadata?: { files?: Array<{ name: string; extension?: string }> } };
    expect(post.metadata?.files?.[0].name).toBe('log.txt');
    expect(post.metadata?.files?.[0].extension).toBe('txt');
  });

  it('carries the attachment CDN url — the id alone is not downloadable', () => {
    const c = makeClient();
    const post = (c as unknown as { normalizePost: (m: unknown, dm: boolean) => unknown }).normalizePost(
      fakeMessage({
        channelId: 'chan-7',
        content: 'screenshot',
        attachments: [{
          id: 'f2',
          name: 'shot.png',
          size: 999,
          contentType: 'image/png',
          url: 'https://cdn.discordapp.com/attachments/1/2/shot.png?ex=abc',
        }],
      }),
      false,
    ) as { metadata?: { files?: Array<{ url?: string }> } };
    expect(post.metadata?.files?.[0].url).toBe('https://cdn.discordapp.com/attachments/1/2/shot.png?ex=abc');
  });
});

describe('DiscordClient downloadFile', () => {
  it('rejects a bare attachment id with an actionable error', async () => {
    const c = makeClient();
    await expect(c.downloadFile('1234567890123456789')).rejects.toThrow(/attachment URL/);
  });
});

describe('DiscordClient home-channel gating (no allChannels)', () => {
  const incoming = (c: DiscordClient, m: unknown) =>
    (c as unknown as { handleIncoming: (m: unknown) => Promise<void> }).handleIncoming(m);

  function collectChannelPosts(c: DiscordClient): Array<{ channelId: string }> {
    const posts: Array<{ channelId: string }> = [];
    c.on('channel_post', (p) => posts.push(p as { channelId: string }));
    return posts;
  }

  it('accepts messages in a native thread of the home channel — !thread sessions live there', async () => {
    const c = makeClient(); // no allChannels
    const posts = collectChannelPosts(c);
    await incoming(c, fakeMessage({
      channelId: 'thread-55',
      threadParentId: 'home-channel-123',
      content: 'follow-up inside the thread',
    }));
    expect(posts.length).toBe(1);
    expect(posts[0].channelId).toBe('thread-55');
  });

  it('still drops messages in threads of OTHER channels', async () => {
    const c = makeClient();
    const posts = collectChannelPosts(c);
    await incoming(c, fakeMessage({
      channelId: 'thread-66',
      threadParentId: 'some-other-channel',
      content: 'not for us',
    }));
    expect(posts.length).toBe(0);
  });

  it('still drops messages in unrelated plain channels', async () => {
    const c = makeClient();
    const posts = collectChannelPosts(c);
    await incoming(c, fakeMessage({ channelId: 'random-chan', content: 'nope' }));
    expect(posts.length).toBe(0);
  });
});
