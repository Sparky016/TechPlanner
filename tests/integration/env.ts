// Minimal valid configuration for integration tests. Only fills variables that are unset,
// so a real DATABASE_URL (or any other value) from the environment always wins.
// Must be imported before anything that calls getConfig() at module load.

const defaults: Record<string, string> = {
  ATLASSIAN_CLIENT_ID: 'test-client-id',
  ATLASSIAN_CLIENT_SECRET: 'test-client-secret',
  ATLASSIAN_CLOUD_ID: 'test-cloud-id',
  OAUTH_REDIRECT_URI: 'http://localhost:3000/api/auth/callback',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  // Users from scripts/mysql-bootstrap.sql: queries run as the app user, setup.ts resets and migrates as the owner.
  // setup.ts takes the database name from DATABASE_URL only, so overriding DATABASE_URL picks another database.
  DATABASE_URL: 'mysql://techplanner_app:app-dev-password@localhost:3306/techplanner_test',
  MIGRATE_DATABASE_URL: 'mysql://techplanner_owner:owner-dev-password@localhost:3306/techplanner_test',
  COPILOT_GITHUB_TOKEN: 'test-copilot-token',
  FACILITATOR_MODEL: 'test-facilitator-model',
  EVALUATOR_MODEL: 'test-evaluator-model',
  CONFLUENCE_SPACE_KEY: 'TEST',
  CONFLUENCE_PARENT_PAGE_ID: '1',
  APP_BASE_URL: 'http://localhost:3000',
};

for (const [name, value] of Object.entries(defaults)) {
  if (!process.env[name]) process.env[name] = value;
}

export {};
