const { defineConfig } = require('vite');

module.exports = defineConfig({
  root: 'src/renderer',
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: '../../dist/renderer',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('highlight.js')) return 'vendor-hljs';
          if (id.includes('xterm')) return 'vendor-xterm';
          if (id.includes('marked')) return 'vendor-marked';
        },
      },
    },
  },
});
