export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function normalizeProject(project) {
  if (!project || typeof project !== 'object') return null;
  if (typeof project.id !== 'string' || typeof project.name !== 'string' || typeof project.cwd !== 'string') {
    return null;
  }
  return { id: project.id, name: project.name, cwd: project.cwd };
}

export function agentLabel(type) {
  const map = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    opencode: 'OpenCode',
    gemini: 'Gemini CLI',
    kimi: 'Kimi CLI',
    goose: 'Goose',
    aider: 'Aider',
    shell: 'Shell',
  };
  return map[type] || type;
}

export async function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return;

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back to execCommand below.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}
