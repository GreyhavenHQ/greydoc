import { defineConfig } from '@playwright/test'

const port = 3999

// Runs against the built binary (just e2e builds it first) on a throwaway database.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  webServer: {
    command: `rm -rf /tmp/greydoc-e2e && mkdir -p /tmp/greydoc-e2e && ../bin/greydoc serve --port ${port}`,
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    env: {
      GREYDOC_DATABASE_URL: '/tmp/greydoc-e2e/greydoc.db',
      GREYDOC_DATA_DIR: '/tmp/greydoc-e2e/data',
      GREYDOC_SECRET_FILE: '/tmp/greydoc-e2e/secret',
      GREYDOC_MIRROR_DEBOUNCE: '200ms',
      GREYDOC_ROOM_SAVE_INTERVAL: '200ms',
      LLM_API_BASEURL: '',
    },
  },
})
