const DARK_THEME = {
  background: '#000000',
  foreground: '#fafafa',
  cursor: '#0070f3',
  selectionBackground: 'rgba(0,112,243,0.25)',
};

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#171717',
  cursor: '#0070f3',
  selectionBackground: 'rgba(0,112,243,0.15)',
};

export function getTerminalTheme(theme) {
  return theme === 'light' ? LIGHT_THEME : DARK_THEME;
}

export function normalizeCommand(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

export function normalizeCommandArgs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item == null) return '';
      return String(item);
    })
    .filter(Boolean);
}

export function formatCommandLabel(command, commandArgs) {
  const normalizedCommand = normalizeCommand(command);
  const args = normalizeCommandArgs(commandArgs);
  if (!normalizedCommand) return '';
  return args.length > 0 ? `${normalizedCommand} ${args.join(' ')}` : normalizedCommand;
}

export function normalizeTerminalSessionId(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
