import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(process.cwd(), 'web'),
  plugins: [react()],
  build: { outDir: resolve(process.cwd(), 'web/dist'), emptyOutDir: true },
});
