const { defineConfig } = require('vite');

module.exports = defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
  },
});
