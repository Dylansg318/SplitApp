import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  // The portfolio embeds the built output from public/demos/receipt-splitter/,
  // so every asset URL must be relative rather than rooted at /.
  base: './',
  build: { target: 'es2022', outDir: 'dist' },
});
