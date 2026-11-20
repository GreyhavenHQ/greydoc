import { defineConfig } from '@playwright/test'

const port = 3999

// Runs against the built binary (just e2e builds it first) on a throwaway database.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  webServer: [
    {
      // The fake identity provider also starts a greydoc with OIDC on port 3996, for people and mentions.
      command: 'node e2e/fake-idp.mjs',
      url: 'http://127.0.0.1:3996/healthz',
      reuseExistingServer: false,
    },
    {
      command: 'node e2e/fake-llm.mjs',
      url: 'http://127.0.0.1:3998/health',
      reuseExistingServer: false,
    },
    {
    command: `rm -rf /tmp/greydoc-e2e && mkdir -p /tmp/greydoc-e2e && ../bin/greydoc serve --port ${port}`,
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    env: {
      GREYDOC_DATABASE_URL: '/tmp/greydoc-e2e/greydoc.db',
      GREYDOC_DATA_DIR: '/tmp/greydoc-e2e/data',
      GREYDOC_SECRET_FILE: '/tmp/greydoc-e2e/secret',
      GREYDOC_ROOM_SAVE_INTERVAL: '200ms',
      LLM_API_BASEURL: 'http://127.0.0.1:3998',
      LLM_MODEL: 'fake',
    },
    },
  ],
})
