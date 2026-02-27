import { state } from './state.js';
import { getActiveProjectTab, getTabDisplayName } from './tabs.js';

export function updateWindowTitle() {
  let title = 'TGClaw — OpenClaw';

  if (state.currentItem !== 'openclaw') {
    const project = state.projects.find((item) => item.id === state.currentItem);
    const active = getActiveProjectTab(state.currentItem);
    const projectName = project ? project.name : 'Unknown Project';
    const tabName = active ? getTabDisplayName(active) : 'No Tab';
    title = `TGClaw — ${projectName} — ${tabName}`;
  }

  window.tgclaw.setWindowTitle(title);
}
