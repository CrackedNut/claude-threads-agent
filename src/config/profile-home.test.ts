/**
 * Profile-home resolver tests — OPENINTEL_HOME re-roots all bot state;
 * unset means the exact legacy locations.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { homedir } from 'os';
import {
  getProfileHome,
  getConfigDir,
  getStateDir,
  getAgentHome,
  getProfilesRoot,
} from './profile-home.js';

const ORIGINAL = process.env.OPENINTEL_HOME;

beforeEach(() => {
  delete process.env.OPENINTEL_HOME;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OPENINTEL_HOME;
  else process.env.OPENINTEL_HOME = ORIGINAL;
});

describe('legacy mode (OPENINTEL_HOME unset)', () => {
  test('resolves the exact pre-profile locations', () => {
    expect(getProfileHome()).toBeNull();
    expect(getConfigDir()).toBe(join(homedir(), '.config', 'claude-threads'));
    expect(getStateDir()).toBe(join(homedir(), '.claude-threads'));
    expect(getAgentHome()).toBe(join(homedir(), '.config', 'claude-threads', 'agent'));
  });

  test('empty / blank value counts as unset', () => {
    process.env.OPENINTEL_HOME = '   ';
    expect(getProfileHome()).toBeNull();
  });
});

describe('profile mode', () => {
  test('all state roots under the profile home', () => {
    process.env.OPENINTEL_HOME = '/tmp/openintel-test/natethropic';
    expect(getProfileHome()).toBe('/tmp/openintel-test/natethropic');
    expect(getConfigDir()).toBe('/tmp/openintel-test/natethropic');
    expect(getStateDir()).toBe('/tmp/openintel-test/natethropic');
    expect(getAgentHome()).toBe('/tmp/openintel-test/natethropic/agent');
  });

  test('tilde expands to the home directory', () => {
    process.env.OPENINTEL_HOME = '~/openintel/bot2';
    expect(getProfileHome()).toBe(join(homedir(), 'openintel', 'bot2'));
  });

  test('profiles root is ~/openintel', () => {
    expect(getProfilesRoot()).toBe(join(homedir(), 'openintel'));
  });
});
