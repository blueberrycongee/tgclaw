import { state } from './state.js';
import { getActiveProjectTab, getTabDisplayName } from './tabs.js';
import { isChatItemId, isSessionItemId } from './utils.js';

export function updateWindowTitle() {
  let title = 'TGClaw — OpenClaw';

  if (isSessionItemId(state.currentItem)) {
    const sessionKey = state.currentItem.slice('session:'.length);
    const session = state.sessions.find((item) => item?.sessionKey === sessionKey);
    const label = typeof session?.label === 'string' && session.label.trim() ? session.label.trim() : sessionKey;
    title = `TGClaw — ${label}`;
  } else if (!isChatItemId(state.currentItem)) {
    const project = state.projects.find((item) => item.id === state.currentItem);
    const active = getActiveProjectTab(state.currentItem);
    const projectName = project ? project.name : 'Unknown Project';
    const tabName = active ? getTabDisplayName(active) : 'No Tab';
    title = `TGClaw — ${projectName} — ${tabName}`;
  }

  window.tgclaw.setWindowTitle(title);
}
