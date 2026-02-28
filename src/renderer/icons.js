const ICON_PATHS = {
  logo: `
    <circle cx="12" cy="13" r="3.2"></circle>
    <circle cx="7.2" cy="8.4" r="1.4"></circle>
    <circle cx="12" cy="6.8" r="1.5"></circle>
    <circle cx="16.8" cy="8.4" r="1.4"></circle>
    <path d="M9.3 15.8c.7 1 1.6 1.6 2.7 1.6s2-.6 2.7-1.6"></path>
  `,
  bot: `
    <rect x="5" y="8" width="14" height="11" rx="3"></rect>
    <path d="M12 4v4"></path>
    <circle cx="9.5" cy="13" r="1"></circle>
    <circle cx="14.5" cy="13" r="1"></circle>
    <path d="M8 19v2"></path>
    <path d="M16 19v2"></path>
  `,
  folder: `
    <path d="M3 7a2 2 0 0 1 2-2h3.4l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"></path>
  `,
  plus: `
    <path d="M12 5v14"></path>
    <path d="M5 12h14"></path>
  `,
  moon: `
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"></path>
  `,
  sun: `
    <circle cx="12" cy="12" r="4"></circle>
    <path d="M12 2v2.2"></path>
    <path d="M12 19.8V22"></path>
    <path d="M4.9 4.9 6.5 6.5"></path>
    <path d="M17.5 17.5 19.1 19.1"></path>
    <path d="M2 12h2.2"></path>
    <path d="M19.8 12H22"></path>
    <path d="M4.9 19.1 6.5 17.5"></path>
    <path d="M17.5 6.5 19.1 4.9"></path>
  `,
  chevronUp: `
    <path d="m7 14 5-5 5 5"></path>
  `,
  chevronDown: `
    <path d="m7 10 5 5 5-5"></path>
  `,
  close: `
    <path d="M6 6 18 18"></path>
    <path d="M18 6 6 18"></path>
  `,
  settings: `
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 .9-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 .9 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5.9h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5.9Z"></path>
  `,
  send: `
    <path d="M12 19V5"></path>
    <path d="m6 11 6-6 6 6"></path>
  `,
  stop: `
    <rect x="6" y="6" width="12" height="12" rx="2"></rect>
  `,
  terminal: `
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect>
    <path d="m8 10 3 2-3 2"></path>
    <path d="M12.5 15h3.5"></path>
  `,
  sparkles: `
    <path d="M12 3 13.8 7.2 18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3Z"></path>
    <path d="m5 3 .8 1.8 1.8.8-1.8.8L5 8.2l-.8-1.8-1.8-.8 1.8-.8L5 3Z"></path>
    <path d="m19 15 .8 1.8 1.8.8-1.8.8-.8 1.8-.8-1.8-1.8-.8 1.8-.8.8-1.8Z"></path>
  `,
  braces: `
    <path d="M9 5c-2 0-3 1-3 3v2c0 1-.5 2-2 2 1.5 0 2 1 2 2v2c0 2 1 3 3 3"></path>
    <path d="M15 5c2 0 3 1 3 3v2c0 1 .5 2 2 2-1.5 0-2 1-2 2v2c0 2-1 3-3 3"></path>
  `,
  compass: `
    <circle cx="12" cy="12" r="9"></circle>
    <path d="m16.5 7.5-3.2 7.2-7.2 3.2 3.2-7.2 7.2-3.2Z"></path>
    <circle cx="12" cy="12" r="1.2"></circle>
  `,
  wrench: `
    <path d="M14.7 6.3a3.5 3.5 0 0 0 4.9 4.9L13 17.8 9.2 14l5.5-5.5Z"></path>
    <path d="m7.5 15.7-3 3a1.2 1.2 0 1 0 1.7 1.7l3-3"></path>
  `,
  cube: `
    <path d="m12 3 7 4v10l-7 4-7-4V7l7-4Z"></path>
    <path d="m12 3 7 4-7 4-7-4"></path>
    <path d="M12 11v10"></path>
  `,
  star4: `
    <path d="M12 3.5 14.5 9l5.5 2.5-5.5 2.5-2.5 5.5-2.5-5.5L4 11.5 9.5 9 12 3.5Z"></path>
  `,
  orbit: `
    <circle cx="12" cy="12" r="2.2"></circle>
    <path d="M12 4c4 0 7.2 2.2 7.2 5s-3.2 5-7.2 5-7.2 2.2-7.2 5"></path>
    <path d="M12 20c-4 0-7.2-2.2-7.2-5s3.2-5 7.2-5 7.2-2.2 7.2-5"></path>
  `,
};

const AGENT_ICON_MAP = {
  'claude-code': 'sparkles',
  codex: 'braces',
  opencode: 'cube',
  gemini: 'star4',
  kimi: 'orbit',
  goose: 'compass',
  aider: 'wrench',
  shell: 'terminal',
};

function iconMarkup(name, className, size, title) {
  const path = ICON_PATHS[name] || ICON_PATHS.terminal;
  const svgTitle = title ? `<title>${title}</title>` : '';
  return `<svg class="ui-icon ${className || ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${svgTitle}${path}</svg>`;
}

export function renderIcon(name, options = {}) {
  const size = Number.isFinite(options.size) ? options.size : 16;
  const className = typeof options.className === 'string' ? options.className : '';
  const title = typeof options.title === 'string' ? options.title : '';
  return iconMarkup(name, className, size, title);
}

export function renderAgentIcon(type, options = {}) {
  const iconName = AGENT_ICON_MAP[type] || 'terminal';
  return renderIcon(iconName, options);
}

function setElementIcon(id, iconName, options = {}) {
  const element = document.getElementById(id);
  if (!element) return;
  element.innerHTML = renderIcon(iconName, options);
}

export function initStaticIcons() {
  setElementIcon('brand-icon', 'logo', { size: 16, className: 'brand-glyph' });
  setElementIcon('openclaw-icon', 'bot', { size: 16, className: 'sidebar-glyph' });
  setElementIcon('add-tab', 'plus', { size: 16, className: 'action-glyph' });
  setElementIcon('terminal-search-prev', 'chevronUp', { size: 14, className: 'action-glyph' });
  setElementIcon('terminal-search-next', 'chevronDown', { size: 14, className: 'action-glyph' });
  setElementIcon('terminal-search-close', 'close', { size: 14, className: 'action-glyph' });
  setElementIcon('gateway-settings-btn', 'settings', { size: 14, className: 'action-glyph' });
  setElementIcon('gateway-settings-close', 'close', { size: 14, className: 'action-glyph' });
  setElementIcon('chat-send', 'send', { size: 16, className: 'action-glyph' });
  setElementIcon('chat-stop', 'stop', { size: 16, className: 'action-glyph' });

  document.querySelectorAll('.agent-option-icon[data-agent-icon]').forEach((element) => {
    const agentType = element.getAttribute('data-agent-icon') || '';
    element.innerHTML = renderAgentIcon(agentType, { size: 16, className: 'agent-glyph' });
  });

  document.querySelectorAll('.quick-agent-icon[data-agent-icon]').forEach((element) => {
    const agentType = element.getAttribute('data-agent-icon') || '';
    element.innerHTML = renderAgentIcon(agentType, { size: 14, className: 'quick-agent-glyph' });
  });
}
