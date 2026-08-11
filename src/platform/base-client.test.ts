/**
 * Tests for BasePlatformClient reconnection behavior.
 */

import { describe, it, expect } from 'bun:test';
import { BasePlatformClient } from './base-client.js';

/**
 * Minimal concrete subclass. Only the members exercised by the reconnect
 * path are functional; everything else throws.
 */
class TestClient extends BasePlatformClient {
  readonly platformId = 'test';
  readonly platformType = 'test';
  readonly displayName = 'Test';

  connectAttempts = 0;
  /** connect() throws until this many attempts have been made. */
  failFirstN = 0;
  connected = false;

  constructor() {
    super();
    // Tiny delays so real timers stay fast in tests
    this.reconnectDelay = 1;
    (this as unknown as { maxReconnectDelay: number }).maxReconnectDelay = 5;
  }

  async connect(): Promise<void> {
    this.connectAttempts++;
    if (this.connectAttempts <= this.failFirstN) {
      throw new Error('fetch failed');
    }
    this.connected = true;
    this.onConnectionEstablished();
  }

  triggerReconnect(): void {
    this.scheduleReconnect();
  }

  protected async forceCloseConnection(): Promise<void> {}
  protected async recoverMissedMessages(): Promise<void> {}

  async getBotUser(): Promise<never> { throw new Error('not implemented'); }
  async getUser(): Promise<never> { throw new Error('not implemented'); }
  async getUserByUsername(): Promise<never> { throw new Error('not implemented'); }
  getHomeChannelId(): string { return 'home'; }
  async createPost(): Promise<never> { throw new Error('not implemented'); }
  async updatePost(): Promise<never> { throw new Error('not implemented'); }
  async getPost(): Promise<never> { throw new Error('not implemented'); }
  async deletePost(): Promise<never> { throw new Error('not implemented'); }
  async addReaction(): Promise<never> { throw new Error('not implemented'); }
  async removeReaction(): Promise<never> { throw new Error('not implemented'); }
  async pinPost(): Promise<never> { throw new Error('not implemented'); }
  async unpinPost(): Promise<never> { throw new Error('not implemented'); }
  async getPinnedPosts(): Promise<never> { throw new Error('not implemented'); }
  getMessageLimits(): { maxLength: number; hardThreshold: number } {
    return { maxLength: 16000, hardThreshold: 12000 };
  }
  async getThreadHistory(): Promise<never> { throw new Error('not implemented'); }
  async getChannelHistory(): Promise<never> { throw new Error('not implemented'); }
  isBotMentioned(): boolean { return false; }
  extractPrompt(message: string): string { return message; }
  sendTyping(): void {}
  getThreadLink(): string { return ''; }
  getMcpConfig(): never { throw new Error('not implemented'); }
  getFormatter(): never { throw new Error('not implemented'); }
  async downloadFile(): Promise<never> { throw new Error('not implemented'); }
  async getFileInfo(): Promise<never> { throw new Error('not implemented'); }
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('BasePlatformClient reconnection (RED-GREEN regression test)', () => {
  // BUG: scheduleReconnect gave up permanently once reconnectAttempts hit
  // maxReconnectAttempts (10). After any outage longer than the backoff
  // ladder (~17 min), the daemon stayed up but never reconnected — a zombie
  // bot that ignores all messages until a manual restart. Observed twice in
  // production against chat.liveequity.io.

  it('keeps retrying past maxReconnectAttempts and eventually reconnects', async () => {
    const client = new TestClient();
    // Fail 12 attempts — two past the old give-up cap of 10
    client.failFirstN = 12;

    client.triggerReconnect();
    await waitFor(() => client.connected, 3000);

    expect(client.connected).toBe(true);
    expect(client.connectAttempts).toBeGreaterThan(10);

    await client.disconnect();
  });

  it('caps the exponential backoff delay at maxReconnectDelay', () => {
    const client = new TestClient();
    const getDelay = (attempt: number) =>
      (client as unknown as { getReconnectDelay(a: number): number }).getReconnectDelay(attempt);

    expect(getDelay(1)).toBe(1); // reconnectDelay * 2^0
    expect(getDelay(2)).toBe(2);
    expect(getDelay(20)).toBe(5); // capped at maxReconnectDelay
    expect(getDelay(1000)).toBe(5); // 2^999 overflows to Infinity — still capped
  });

  it('stops retrying after an intentional disconnect', async () => {
    const client = new TestClient();
    client.failFirstN = Infinity;

    client.triggerReconnect();
    await new Promise((r) => setTimeout(r, 30));
    await client.disconnect();

    await new Promise((r) => setTimeout(r, 50));
    const attemptsAtDisconnect = client.connectAttempts;
    await new Promise((r) => setTimeout(r, 50));

    expect(client.connectAttempts).toBe(attemptsAtDisconnect);
  });
});
