const Store = require('electron-store');

const StoreConstructor = Store.default || Store;
const options = {};
if (typeof process.env.TGCLAW_USER_DATA_DIR === 'string' && process.env.TGCLAW_USER_DATA_DIR.trim()) {
  options.cwd = process.env.TGCLAW_USER_DATA_DIR.trim();
}
const store = new StoreConstructor(options);

module.exports = { store };
