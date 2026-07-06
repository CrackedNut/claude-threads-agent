/**
 * Discord platform client.
 *
 * Uses discord.js for the Gateway (IDENTIFY / heartbeat / RESUME / reconnect
 * are the library's job — so this client does NOT use the base-class silence
 * heartbeat). Everything else implements the OpenIntel `PlatformClient`
 * contract by mapping discord.js objects to the normalized types.
 *
 * Conversation model: every Discord channel — text channel, thread channel,
 * or DM — maps to ONE channel-mode session keyed by that channel's id (the
 * normalizer always leaves `rootId` undefined, so the message-handler routes
 * it as a channel post). This rides the `allChannels` channel-mode routing:
 * the bot replies in whatever channel/thread the message arrived in, and a
 * native Discord thread is just another channel with its own session.
 *
 * Required privileged intent: MESSAGE CONTENT (enable in the Developer Portal,
 * Bot → Privileged Gateway Intents) — without it message text arrives empty.
 */
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  PermissionFlagsBits,
  type Message,
  type TextBasedChannel,
  type User as DiscordUser,
  type MessageReaction,
  type PartialMessageReaction,
  type User as ReactingUser,
  type PartialUser,
} from 'discord.js';
import { BasePlatformClient } from '../base-client.js';
import type {
  PlatformUser,
  PlatformPost,
  PlatformReaction,
  PlatformFile,
  ThreadMessage,
} from '../index.js';
import type { PlatformFormatter } from '../formatter.js';
import { DiscordFormatter } from './formatter.js';
import { toDiscordEmoji, fromDiscordEmoji } from './emoji-map.js';
import { truncateMessageSafely } from '../utils.js';
import { createLogger } from '../../utils/logger.js';
import type { DiscordPlatformConfig } from '../../config/index.js';

const log = createLogger('discord');

const DISCORD_MAX_MESSAGE = 2000;
const INDEX_MAX = 4000;

export class DiscordClient extends BasePlatformClient {
  readonly platformId: string;
  readonly platformType = 'discord' as const;
  readonly displayName: string;

  private token: string;
  private channelId: string;
  private allChannels: boolean;
  private outboundFiles?: { enabled?: boolean; maxBytes?: number };
  private readonly formatter = new DiscordFormatter();

  private client: Client | null = null;
  private botUserId: string | null = null;
  private botUsername: string | null = null;

  // messageId → channelId. Discord's reaction / edit / fetch APIs all need the
  // channel, but the PlatformClient methods only get a message id, so we learn
  // the mapping from every message we send or receive (bounded FIFO).
  private messageChannel: Map<string, string> = new Map();

  constructor(config: DiscordPlatformConfig) {
    super();
    this.platformId = config.id;
    this.displayName = config.displayName;
    this.token = config.token;
    this.channelId = config.channelId;
    this.allChannels = config.allChannels === true;
    this.allowedUsers = config.allowedUsers ?? [];
    this.botName = config.botName;
    this.outboundFiles = config.outboundFiles;
  }

  // ---------------------------------------------------------------------------
  // Connection (delegated to discord.js)
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
      ],
      // Partials let us receive events for uncached DMs / reactions.
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });
    this.client = client;

    client.on(Events.MessageCreate, (m) => {
      void this.handleIncoming(m).catch((err) => log.warn(`handleIncoming failed: ${err}`));
    });
    client.on(Events.MessageReactionAdd, (r, u) => {
      void this.handleReaction('reaction', r, u);
    });
    client.on(Events.MessageReactionRemove, (r, u) => {
      void this.handleReaction('reaction_removed', r, u);
    });
    client.on(Events.ShardDisconnect, () => this.emit('disconnected'));
    client.on(Events.ShardReconnecting, () => this.emit('reconnecting', 1));
    client.on(Events.Error, (err) => this.emit('error', err));

    await new Promise<void>((resolve, reject) => {
      client.once(Events.ClientReady, (c) => {
        this.botUserId = c.user.id;
        this.botUsername = c.user.username;
        log.info(`Connected to Discord as ${c.user.tag} (${c.user.id})`);
        this.emit('connected');
        resolve();
      });
      client.login(this.token).catch((err) => reject(this.explainLoginError(err)));
    });
  }

  /**
   * Turn discord.js's terse login failures into actionable guidance — the
   * "disallowed intents" one in particular trips up every first-time setup.
   */
  private explainLoginError(err: unknown): Error {
    const msg = err instanceof Error ? err.message : String(err);
    if (/disallowed intents/i.test(msg)) {
      return new Error(
        'Discord rejected the connection: the MESSAGE CONTENT intent is not enabled. ' +
          'Enable it at https://discord.com/developers/applications → your app → Bot → ' +
          'Privileged Gateway Intents → toggle "MESSAGE CONTENT INTENT" on, Save, then restart.',
      );
    }
    if (/token/i.test(msg) && /invalid/i.test(msg)) {
      return new Error('Discord rejected the bot token (invalid). Reset it in the Developer Portal → Bot → Reset Token.');
    }
    return err instanceof Error ? err : new Error(msg);
  }

  protected forceCloseConnection(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (!c) return Promise.resolve();
    return Promise.resolve(c.destroy()).catch(() => undefined);
  }

  protected async recoverMissedMessages(): Promise<void> {
    // discord.js replays MESSAGE_CREATE across RESUME, so there's nothing to
    // backfill here in the common case. Full session restarts are rare and
    // the channel-mode sticky/mention flow tolerates a missed message.
    log.debug('recoverMissedMessages: relying on discord.js gateway replay');
  }

  // ---------------------------------------------------------------------------
  // Incoming events
  // ---------------------------------------------------------------------------

  private indexMessage(messageId: string, channelId: string): void {
    if (this.messageChannel.size >= INDEX_MAX && !this.messageChannel.has(messageId)) {
      const oldest = this.messageChannel.keys().next().value;
      if (oldest !== undefined) this.messageChannel.delete(oldest);
    }
    this.messageChannel.set(messageId, channelId);
  }

  private async handleIncoming(message: Message): Promise<void> {
    if (message.author?.id === this.botUserId) return; // our own message
    if (message.author?.bot) return; // ignore other bots
    // Only default messages and replies carry user content we care about.
    if (message.system) return;

    const isDM = message.channel.type === ChannelType.DM;
    // Home-channel gating without allChannels: only the configured channel
    // (and DMs) talk to the bot. With allChannels, every visible channel does.
    // Native threads hanging off the home channel count as home — !thread
    // spawns sessions in them, so dropping their messages would let the bot
    // create a thread it then ignores.
    const isHomeThread = this.isThreadOf(message.channel, this.channelId);
    if (!this.allChannels && !isDM && message.channel.id !== this.channelId && !isHomeThread) return;

    this.indexMessage(message.id, message.channel.id);
    const post = this.normalizePost(message, isDM);
    const user = message.author ? this.normalizeUser(message.author) : null;
    this.emit('message', post, user);
    // Every Discord channel is a "channel post" (no thread-reply concept here).
    this.emit('channel_post', post, user);
  }

  private async handleReaction(
    event: 'reaction' | 'reaction_removed',
    reaction: MessageReaction | PartialMessageReaction,
    user: ReactingUser | PartialUser,
  ): Promise<void> {
    try {
      if (user.id === this.botUserId) return; // ignore our own option-reactions
      const full = reaction.partial ? await reaction.fetch() : reaction;
      const glyph = full.emoji.name ?? '';
      this.indexMessage(full.message.id, full.message.channelId);
      const normalized: PlatformReaction = {
        userId: user.id,
        postId: full.message.id,
        emojiName: fromDiscordEmoji(glyph),
        createAt: Date.now(),
      };
      const fetchedUser = user.partial ? await user.fetch() : user;
      this.emit(event, normalized, this.normalizeUser(fetchedUser));
    } catch (err) {
      log.debug(`reaction handling failed: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Normalization
  // ---------------------------------------------------------------------------

  private normalizeUser(u: DiscordUser | PartialUser): PlatformUser {
    return {
      id: u.id,
      username: u.username ?? u.id,
      displayName: (u as DiscordUser).globalName ?? u.username ?? u.id,
    };
  }

  private normalizePost(message: Message, isDM: boolean): PlatformPost {
    // In DMs there's no @mention, but the message-handler requires one to
    // start a session — inject the bot mention so DMs "just work".
    const content =
      isDM && this.botUserId ? `<@${this.botUserId}> ${message.content}` : message.content;
    const files = message.attachments.size
      ? [...message.attachments.values()].map((a) => this.normalizeFile(a))
      : undefined;
    return {
      id: message.id,
      platformId: this.platformId,
      channelId: message.channel.id,
      userId: message.author?.id ?? '',
      message: content,
      // Always channel-root: every Discord channel/thread is its own session.
      rootId: undefined,
      createAt: message.createdTimestamp,
      metadata: files ? { files } : undefined,
    };
  }

  private normalizeFile(a: { id: string; name: string; size: number; contentType?: string | null; url: string }): PlatformFile {
    const ext = a.name.includes('.') ? a.name.split('.').pop() : undefined;
    return {
      id: a.id,
      name: a.name,
      size: a.size,
      mimeType: a.contentType ?? 'application/octet-stream',
      extension: ext,
      // Discord attachments download from a (signed, expiring) CDN URL — the
      // snowflake id alone is not fetchable. downloadFile() needs this.
      url: a.url,
    };
  }

  // ---------------------------------------------------------------------------
  // Identity / config
  // ---------------------------------------------------------------------------

  async getBotUser(): Promise<PlatformUser> {
    if (this.client?.user) {
      this.botUserId = this.client.user.id;
      this.botUsername = this.client.user.username;
      return this.normalizeUser(this.client.user);
    }
    return { id: this.botUserId ?? '', username: this.botUsername ?? this.botName };
  }

  async getUser(userId: string): Promise<PlatformUser | null> {
    try {
      const u = await this.client?.users.fetch(userId);
      return u ? this.normalizeUser(u) : null;
    } catch {
      return null;
    }
  }

  async getUserByUsername(username: string): Promise<PlatformUser | null> {
    // Best-effort: scan the cache (a full lookup needs the privileged members
    // intent + a guild scan, which we avoid). IDs are the reliable key.
    const u = this.client?.users.cache.find((x) => x.username === username);
    return u ? this.normalizeUser(u) : null;
  }

  getHomeChannelId(): string {
    return this.channelId;
  }

  getMcpConfig() {
    return {
      type: 'discord',
      id: this.platformId,
      url: 'https://discord.com',
      token: this.token,
      channelId: this.channelId,
      allowedUsers: this.allowedUsers,
      outboundFiles: this.outboundFiles,
    };
  }

  getFormatter(): PlatformFormatter {
    return this.formatter;
  }

  getThreadLink(threadId: string, lastMessageId?: string): string {
    // threadId is a channel id; lastMessageId points at a specific message.
    const guildId = this.client?.channels.cache.get(threadId)?.isTextBased()
      ? (this.client.channels.cache.get(threadId) as { guildId?: string }).guildId
      : undefined;
    const base = guildId ?? '@me';
    return lastMessageId
      ? `https://discord.com/channels/${base}/${threadId}/${lastMessageId}`
      : `https://discord.com/channels/${base}/${threadId}`;
  }

  getMessageLimits(): { maxLength: number; hardThreshold: number } {
    return { maxLength: DISCORD_MAX_MESSAGE, hardThreshold: 1900 };
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /** Resolve a channel id to a sendable text channel. */
  private async resolveChannel(channelId: string): Promise<TextBasedChannel | null> {
    try {
      const c =
        this.client?.channels.cache.get(channelId) ??
        (await this.client?.channels.fetch(channelId)) ??
        null;
      return c && c.isTextBased() ? (c as TextBasedChannel) : null;
    } catch {
      return null;
    }
  }

  private truncate(message: string): string {
    return message.length <= DISCORD_MAX_MESSAGE
      ? message
      : truncateMessageSafely(message, DISCORD_MAX_MESSAGE, '\n_… (truncated)_');
  }

  async createPost(message: string, threadId?: string): Promise<PlatformPost> {
    // threadId is a channel id (channel-mode session key) — or undefined →
    // the home channel. Discord threads are channels, so this covers both
    // "reply in channel" and "reply in thread".
    const channelId = threadId || this.channelId;
    const channel = await this.resolveChannel(channelId);
    if (!channel || !('send' in channel)) {
      throw new Error(`Discord channel ${channelId} not found or not sendable`);
    }
    const sent = await channel.send({
      content: this.truncate(message),
      allowedMentions: { parse: ['users'] }, // never @everyone / @here / roles
    });
    this.indexMessage(sent.id, channelId);
    return {
      id: sent.id,
      platformId: this.platformId,
      channelId,
      userId: this.botUserId ?? '',
      message,
      rootId: threadId,
      createAt: sent.createdTimestamp,
    };
  }

  /** Is `channel` a native thread whose parent is `parentChannelId`? */
  private isThreadOf(channel: unknown, parentChannelId: string): boolean {
    const c = channel as { isThread?: () => boolean; parentId?: string | null };
    return typeof c.isThread === 'function' && c.isThread() && c.parentId === parentChannelId;
  }

  /**
   * Start a native Discord thread hanging off the anchor message. Returns the
   * thread channel's id — which becomes the session's channel (a Discord
   * thread is just another text channel, so it runs as a channel-mode
   * session).
   *
   * Permission pre-flight: creating a thread needs "Create Public Threads",
   * but POSTING in it needs the separate "Send Messages in Threads" grant.
   * Without the pre-flight, a bot missing the latter creates the thread and
   * then silently fails every post inside it — the session looks started but
   * never says a word. Refuse up front with the exact missing permission so
   * the caller can tell the user what to fix.
   */
  async createThread(
    parentChannelId: string,
    anchorPostId: string,
    name: string,
  ): Promise<{ id: string } | { error: string }> {
    try {
      const channel = await this.resolveChannel(parentChannelId);
      if (!channel || !('messages' in channel)) {
        return { error: `channel ${parentChannelId} not found or not text-based` };
      }
      if (!('threads' in channel)) {
        return { error: 'this channel type does not support threads (DMs have no thread sessions — just keep chatting here)' };
      }
      if (this.client?.user && 'permissionsFor' in channel) {
        const perms = channel.permissionsFor(this.client.user);
        const missing = [
          [PermissionFlagsBits.CreatePublicThreads, 'Create Public Threads'],
          [PermissionFlagsBits.SendMessagesInThreads, 'Send Messages in Threads'],
        ]
          .filter(([flag]) => perms && !perms.has(flag as bigint))
          .map(([, label]) => label as string);
        if (missing.length > 0) {
          return {
            error:
              `the bot is missing the ${missing.map((m) => `"${m}"`).join(' and ')} ` +
              `permission${missing.length > 1 ? 's' : ''} in this channel — update the bot's role or re-invite it, then retry`,
          };
        }
      }
      const msg = await channel.messages.fetch(anchorPostId);
      const thread = await msg.startThread({
        name: (name || 'Claude session').slice(0, 100),
        autoArchiveDuration: 1440,
      });
      // No index needed — resolveChannel fetches the thread directly (a
      // Discord thread is a channel), so replies via createPost(thread.id) work.
      return { id: thread.id };
    } catch (err) {
      log.warn(`createThread failed: ${err}`);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async updatePost(postId: string, message: string): Promise<PlatformPost> {
    const channelId = this.messageChannel.get(postId) ?? this.channelId;
    const channel = await this.resolveChannel(channelId);
    if (!channel) throw new Error(`Discord channel ${channelId} not found`);
    const msg = await channel.messages.fetch(postId);
    const edited = await msg.edit({
      content: this.truncate(message),
      allowedMentions: { parse: ['users'] },
    });
    return {
      id: edited.id,
      platformId: this.platformId,
      channelId,
      userId: this.botUserId ?? '',
      message,
      createAt: edited.createdTimestamp,
    };
  }

  async getPost(postId: string): Promise<PlatformPost | null> {
    const channelId = this.messageChannel.get(postId);
    if (!channelId) return null;
    try {
      const channel = await this.resolveChannel(channelId);
      const msg = await channel?.messages.fetch(postId);
      if (!msg) return null;
      return this.normalizePost(msg, msg.channel.type === ChannelType.DM);
    } catch {
      return null;
    }
  }

  async deletePost(postId: string): Promise<void> {
    const channelId = this.messageChannel.get(postId) ?? this.channelId;
    const channel = await this.resolveChannel(channelId);
    const msg = await channel?.messages.fetch(postId);
    await msg?.delete();
  }

  // Discord has no per-channel "pinned sticky" the way Mattermost/Slack pins
  // are used; implement pins faithfully so the sticky-message machinery works.
  async pinPost(postId: string): Promise<void> {
    const channel = await this.resolveChannel(this.messageChannel.get(postId) ?? this.channelId);
    const msg = await channel?.messages.fetch(postId);
    await msg?.pin().catch((e) => log.debug(`pin failed: ${e}`));
  }

  async unpinPost(postId: string): Promise<void> {
    const channel = await this.resolveChannel(this.messageChannel.get(postId) ?? this.channelId);
    const msg = await channel?.messages.fetch(postId).catch(() => null);
    await msg?.unpin().catch((e) => log.debug(`unpin failed: ${e}`));
  }

  async getPinnedPosts(): Promise<string[]> {
    const channel = await this.resolveChannel(this.channelId);
    if (!channel || !('messages' in channel)) return [];
    try {
      const pins = await channel.messages.fetchPinned();
      return [...pins.keys()];
    } catch {
      return [];
    }
  }

  async getThreadHistory(
    threadId: string,
    options?: { limit?: number; excludeBotMessages?: boolean },
  ): Promise<ThreadMessage[]> {
    return this.fetchHistory(threadId, options);
  }

  async getChannelHistory(
    options?: { limit?: number; excludeBotMessages?: boolean; channelId?: string },
  ): Promise<ThreadMessage[]> {
    return this.fetchHistory(options?.channelId ?? this.channelId, options);
  }

  private async fetchHistory(
    channelId: string,
    options?: { limit?: number; excludeBotMessages?: boolean },
  ): Promise<ThreadMessage[]> {
    const channel = await this.resolveChannel(channelId);
    if (!channel || !('messages' in channel)) return [];
    try {
      const limit = Math.min(options?.limit ?? 30, 100);
      const fetched = await channel.messages.fetch({ limit });
      const out: ThreadMessage[] = [];
      for (const m of fetched.values()) {
        if (m.system) continue;
        if (options?.excludeBotMessages && m.author?.id === this.botUserId) continue;
        out.push({
          id: m.id,
          userId: m.author?.id ?? '',
          username: m.author?.username ?? 'unknown',
          message: m.content,
          createAt: m.createdTimestamp,
        });
      }
      // discord.js returns newest-first; the contract is oldest-first.
      return out.sort((a, b) => a.createAt - b.createAt);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Reactions
  // ---------------------------------------------------------------------------

  async addReaction(postId: string, emojiName: string): Promise<void> {
    const channel = await this.resolveChannel(this.messageChannel.get(postId) ?? this.channelId);
    const msg = await channel?.messages.fetch(postId).catch(() => null);
    if (!msg) {
      log.debug(`addReaction: message ${postId} not resolvable`);
      return;
    }
    await msg.react(toDiscordEmoji(emojiName)).catch((e) => log.debug(`react failed: ${e}`));
  }

  async removeReaction(postId: string, emojiName: string): Promise<void> {
    const channel = await this.resolveChannel(this.messageChannel.get(postId) ?? this.channelId);
    const msg = await channel?.messages.fetch(postId).catch(() => null);
    if (!msg || !this.botUserId) return;
    const glyph = toDiscordEmoji(emojiName);
    const reaction = msg.reactions.cache.find((r) => r.emoji.name === glyph);
    await reaction?.users.remove(this.botUserId).catch((e) => log.debug(`unreact failed: ${e}`));
  }

  // ---------------------------------------------------------------------------
  // Mentions
  // ---------------------------------------------------------------------------

  isBotMentioned(message: string): boolean {
    if (!this.botUserId) return false;
    return new RegExp(`<@!?${this.botUserId}>`).test(message);
  }

  extractPrompt(message: string): string {
    if (!this.botUserId) return message.trim();
    return message.replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), ' ').trim();
  }

  // ---------------------------------------------------------------------------
  // Typing & files
  // ---------------------------------------------------------------------------

  sendTyping(threadId?: string): void {
    const channelId = threadId || this.channelId;
    void this.resolveChannel(channelId).then((c) => {
      if (c && 'sendTyping' in c) c.sendTyping().catch(() => undefined);
    });
  }

  async downloadFile(fileUrl: string): Promise<Buffer> {
    // Discord attachment ids aren't directly fetchable; callers pass the CDN
    // URL (PlatformFile.url). Fail loudly on a bare id so the mistake surfaces
    // as a clear skipped-file reason instead of a cryptic fetch error.
    if (!/^https?:\/\//.test(fileUrl)) {
      throw new Error('Discord file downloads need the attachment URL (PlatformFile.url), got a bare id');
    }
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async getFileInfo(): Promise<PlatformFile> {
    throw new Error('getFileInfo not supported on Discord (attachment metadata arrives with the message)');
  }

  async uploadFile(
    filePath: string,
    threadId: string,
    options?: { caption?: string; filename?: string },
  ): Promise<{ postId: string; fileId?: string }> {
    const channel = await this.resolveChannel(threadId || this.channelId);
    if (!channel || !('send' in channel)) {
      throw new Error(`Discord channel ${threadId} not sendable`);
    }
    const sent = await channel.send({
      content: options?.caption,
      files: [{ attachment: filePath, name: options?.filename }],
      allowedMentions: { parse: [] },
    });
    this.indexMessage(sent.id, channel.id);
    return { postId: sent.id, fileId: sent.attachments.first()?.id };
  }
}
