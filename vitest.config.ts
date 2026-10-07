import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      { resolve: { alias }, test: { name: 'node', include: ['src/**/*.test.ts'], environment: 'node' } },
      {
        resolve: { alias },
        oxc: { jsx: { runtime: 'automatic' } },
        test: { name: 'dom', include: ['src/**/*.test.tsx'], environment: 'jsdom' },
      },
    ],
  },
});
