const Store = require('electron-store');

const StoreConstructor = Store.default || Store;
const store = new StoreConstructor();

module.exports = { store };
