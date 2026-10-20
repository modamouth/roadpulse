import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Two pages: the public map (index.html) and the moderator review UI
// (admin.html). Vite's dev server serves both without this; the build
// needs them listed or admin.html is left out of dist/.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
});
