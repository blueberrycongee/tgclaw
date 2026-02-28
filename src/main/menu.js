const { BrowserWindow, Menu } = require('electron');

function sendShortcutAction(action, payload = {}) {
  const window = BrowserWindow.getFocusedWindow();
  if (!window || window.isDestroyed()) return;
  window.webContents.send('app:shortcut', { action, ...payload });
}

function setupApplicationMenu() {
  const switchTabMenuItems = Array.from({ length: 9 }, (_, index) => ({
    label: `Switch to Tab ${index + 1}`,
    accelerator: `CommandOrControl+${index + 1}`,
    click: () => sendShortcutAction('switch-tab', { index }),
  }));

  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Tabs',
      submenu: [
        { label: 'New Shell Tab', accelerator: 'CommandOrControl+T', click: () => sendShortcutAction('new-shell-tab') },
        { label: 'Close Current Tab', accelerator: 'CommandOrControl+W', click: () => sendShortcutAction('close-current-tab') },
        { type: 'separator' },
        ...switchTabMenuItems,
      ],
    },
    {
      label: 'Chat',
      submenu: [
        { label: 'Clear Chat', accelerator: 'CommandOrControl+K', click: () => sendShortcutAction('clear-chat') },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { setupApplicationMenu, sendShortcutAction };
