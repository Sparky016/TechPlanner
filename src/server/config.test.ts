import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig, resetConfigForTests } from './config';

const validEnv: Record<string, string> = {
  ATLASSIAN_CLIENT_ID: 'client-id',
  ATLASSIAN_CLIENT_SECRET: 'super-secret-client',
  ATLASSIAN_CLOUD_ID: 'cloud-id',
  OAUTH_REDIRECT_URI: 'http://localhost:3000/api/auth/callback',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  DATABASE_URL: 'postgres://techplanner:techplanner@localhost:5432/techplanner',
  COPILOT_GITHUB_TOKEN: 'ghp_secrettoken',
  FACILITATOR_MODEL: 'model-a',
  EVALUATOR_MODEL: 'model-b',
  CONFLUENCE_SPACE_KEY: 'ENG',
  CONFLUENCE_PARENT_PAGE_ID: '12345',
  APP_BASE_URL: 'http://localhost:3000',
};

const original = process.env;

beforeEach(() => {
  process.env = { ...validEnv } as unknown as NodeJS.ProcessEnv;
  resetConfigForTests();
});

afterEach(() => {
  process.env = original;
  resetConfigForTests();
});

describe('getConfig', () => {
  it('parses a valid environment with defaults and memoizes', () => {
    const cfg = getConfig();
    expect(cfg.CONTEXT_TOKEN_BUDGET).toBe(150000);
    expect(cfg.DOWNSTREAM_WEBHOOK_URL).toBeUndefined();
    expect(getConfig()).toBe(cfg);
  });

  it('treats empty optional values as unset', () => {
    process.env.COPILOT_CLI_PATH = '';
    process.env.SECTION_WEIGHTS = '';
    process.env.CONTEXT_TOKEN_BUDGET = '';
    const cfg = getConfig();
    expect(cfg.COPILOT_CLI_PATH).toBeUndefined();
    expect(cfg.SECTION_WEIGHTS).toBeUndefined();
    expect(cfg.CONTEXT_TOKEN_BUDGET).toBe(150000);
  });

  it('rejects a TOKEN_ENCRYPTION_KEY that is not 32 bytes', () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64');
    expect(() => getConfig()).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it('rejects DOWNSTREAM_WEBHOOK_URL without DOWNSTREAM_WEBHOOK_SECRET', () => {
    process.env.DOWNSTREAM_WEBHOOK_URL = 'https://example.com/hook';
    expect(() => getConfig()).toThrow(/DOWNSTREAM_WEBHOOK_SECRET/);
    process.env.DOWNSTREAM_WEBHOOK_SECRET = 'shh';
    resetConfigForTests();
    expect(getConfig().DOWNSTREAM_WEBHOOK_SECRET).toBe('shh');
  });

  it('parses JSON overrides and section weights, rejecting bad ones', () => {
    process.env.CONFLUENCE_PROJECT_OVERRIDES = JSON.stringify({ ABC: { spaceKey: 'S', parentPageId: '1' } });
    process.env.SECTION_WEIGHTS = JSON.stringify({ Goals: 2 });
    const cfg = getConfig();
    expect(cfg.CONFLUENCE_PROJECT_OVERRIDES?.ABC.spaceKey).toBe('S');
    expect(cfg.SECTION_WEIGHTS?.Goals).toBe(2);

    resetConfigForTests();
    process.env.SECTION_WEIGHTS = JSON.stringify({ Goals: -1 });
    expect(() => getConfig()).toThrow(/SECTION_WEIGHTS/);
    process.env.SECTION_WEIGHTS = 'not json';
    expect(() => getConfig()).toThrow(/SECTION_WEIGHTS/);
  });

  it('lists every invalid variable name but never any value', () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'bad-key-value-xyz';
    process.env.DATABASE_URL = 'not-a-url-value-abc';
    delete process.env.APP_BASE_URL;
    let message = '';
    try {
      getConfig();
    } catch (e) {
      message = (e as Error).message;
    }
    for (const name of ['TOKEN_ENCRYPTION_KEY', 'DATABASE_URL', 'APP_BASE_URL']) {
      expect(message).toContain(name);
    }
    for (const value of ['bad-key-value-xyz', 'not-a-url-value-abc', 'super-secret-client', 'ghp_secrettoken']) {
      expect(message).not.toContain(value);
    }
  });
});
