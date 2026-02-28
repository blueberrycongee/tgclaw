import { agentLabel } from './utils.js';
let agentPickerSelectionLocked = false;
let addTabHoverHideTimer = null;
let addTabDefaultAgent = 'shell';
const ADD_TAB_DEFAULT_KEY = 'tgclaw:add-tab-default-agent';
const hooks = { addAgentTab: () => Promise.resolve(null) };
function clearAddTabHoverHideTimer() {
  if (addTabHoverHideTimer) clearTimeout(addTabHoverHideTimer);
  addTabHoverHideTimer = null;
}
function getAddTabHoverMenu() { return document.getElementById('add-tab-hover-menu'); }
function getAddTabDefaultAnchor() { return document.getElementById('tab-add-default-anchor'); }
function getAddTabDefaultSubmenu() { return document.getElementById('add-tab-default-submenu'); }
function positionAddTabHoverMenu() {
  const addTabButton = document.getElementById('add-tab');
  const menu = getAddTabHoverMenu();
  if (!addTabButton || !menu) return;
  const rect = addTabButton.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 190;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(rect.bottom + 6)}px`;
}
function positionAddTabDefaultSubmenu() {
  const anchor = getAddTabDefaultAnchor();
  const submenu = getAddTabDefaultSubmenu();
  if (!anchor || !submenu) return;
  const rect = anchor.getBoundingClientRect();
  const submenuWidth = submenu.offsetWidth || 190;
  const submenuHeight = submenu.offsetHeight || 280;
  let left = rect.right + 4;
  if (left + submenuWidth > window.innerWidth - 8) left = rect.left - submenuWidth - 4;
  left = Math.max(8, left);
  let top = rect.top;
  if (top + submenuHeight > window.innerHeight - 8) top = window.innerHeight - submenuHeight - 8;
  top = Math.max(8, top);
  submenu.style.left = `${Math.round(left)}px`;
  submenu.style.top = `${Math.round(top)}px`;
}
function showAddTabDefaultSubmenu() {
  clearAddTabHoverHideTimer();
  const menu = getAddTabHoverMenu();
  const anchor = getAddTabDefaultAnchor();
  const submenu = getAddTabDefaultSubmenu();
  if (!menu?.classList.contains('show') || !anchor || !submenu) return;
  submenu.classList.add('show');
  anchor.setAttribute('aria-expanded', 'true');
  positionAddTabDefaultSubmenu();
}
function hideAddTabDefaultSubmenu() {
  const anchor = getAddTabDefaultAnchor();
  const submenu = getAddTabDefaultSubmenu();
  if (anchor) anchor.setAttribute('aria-expanded', 'false');
  if (submenu) submenu.classList.remove('show');
}
function showAddTabHoverMenu() {
  clearAddTabHoverHideTimer();
  const menu = getAddTabHoverMenu();
  if (!menu) return;
  hideAddTabDefaultSubmenu();
  menu.classList.add('show');
  positionAddTabHoverMenu();
  updateAddTabDefaultUi();
}
export function hideAddTabHoverMenu() {
  clearAddTabHoverHideTimer();
  hideAddTabDefaultSubmenu();
  const menu = getAddTabHoverMenu();
  if (!menu) return;
  menu.classList.remove('show');
}
function scheduleHideAddTabHoverMenu() {
  clearAddTabHoverHideTimer();
  addTabHoverHideTimer = setTimeout(() => hideAddTabHoverMenu(), 180);
}
function getAddTabOptionTypes() {
  const fromSubmenu = Array.from(document.querySelectorAll('#add-tab-default-submenu .tab-add-default-option[data-agent-type]'))
    .map((option) => option.dataset.agentType)
    .filter(Boolean);
  if (fromSubmenu.length > 0) return fromSubmenu;
  return Array.from(document.querySelectorAll('#add-tab-hover-menu .tab-add-option[data-agent-type]'))
    .map((option) => option.dataset.agentType)
    .filter(Boolean);
}
function resolveDefaultAgent() {
  const optionTypes = getAddTabOptionTypes();
  if (optionTypes.length === 0) return 'shell';
  const saved = localStorage.getItem(ADD_TAB_DEFAULT_KEY);
  if (saved && optionTypes.includes(saved)) return saved;
  if (optionTypes.includes('shell')) return 'shell';
  return optionTypes[0];
}
function updateAddTabDefaultUi() {
  const label = agentLabel(addTabDefaultAgent);
  const addTabButton = document.getElementById('add-tab');
  const badge = document.getElementById('add-tab-default-badge');
  const defaultValue = document.getElementById('tab-add-default-value');
  if (addTabButton) addTabButton.title = `New Tab (${label})`;
  if (badge) badge.textContent = `Default: ${label}`;
  if (defaultValue) defaultValue.textContent = label;
  document.querySelectorAll('#add-tab-default-submenu .tab-add-default-option').forEach((option) => {
    const isDefault = option.dataset.agentType === addTabDefaultAgent;
    option.classList.toggle('is-default', isDefault);
  });
}
function setDefaultAgent(type) {
  if (!type || typeof type !== 'string') return;
  addTabDefaultAgent = type;
  localStorage.setItem(ADD_TAB_DEFAULT_KEY, type);
  updateAddTabDefaultUi();
}
export function showAgentPicker() {
  agentPickerSelectionLocked = false;
  hideAddTabHoverMenu();
  document.getElementById('agent-picker')?.classList.add('show');
}
export function hideAgentPicker() {
  agentPickerSelectionLocked = false;
  document.getElementById('agent-picker')?.classList.remove('show');
  hideAddTabHoverMenu();
}
export function initAgentPicker(nextHooks = {}) {
  if (typeof nextHooks.addAgentTab === 'function') hooks.addAgentTab = nextHooks.addAgentTab;
  const addTabButton = document.getElementById('add-tab');
  const addTabHoverMenu = getAddTabHoverMenu();
  const addTabDefaultAnchor = getAddTabDefaultAnchor();
  const addTabDefaultSubmenu = getAddTabDefaultSubmenu();
  if (addTabButton && addTabHoverMenu && addTabDefaultAnchor && addTabDefaultSubmenu) {
    addTabDefaultAgent = resolveDefaultAgent();
    updateAddTabDefaultUi();
    addTabButton.addEventListener('mouseenter', () => showAddTabHoverMenu());
    addTabButton.addEventListener('mouseleave', () => scheduleHideAddTabHoverMenu());
    addTabButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideAddTabHoverMenu();
      void hooks.addAgentTab(addTabDefaultAgent);
    });
    addTabHoverMenu.addEventListener('mouseenter', () => clearAddTabHoverHideTimer());
    addTabHoverMenu.addEventListener('mouseleave', () => scheduleHideAddTabHoverMenu());
    addTabHoverMenu.querySelectorAll('.tab-add-option').forEach((option) => option.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const type = option.dataset.agentType;
      if (!type || agentPickerSelectionLocked) return;
      agentPickerSelectionLocked = true;
      option.classList.add('pick-feedback');
      setTimeout(() => {
        option.classList.remove('pick-feedback');
        hideAddTabHoverMenu();
        void hooks.addAgentTab(type);
        agentPickerSelectionLocked = false;
      }, 120);
    }));
    addTabDefaultAnchor.addEventListener('mouseenter', () => showAddTabDefaultSubmenu());
    addTabDefaultAnchor.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showAddTabDefaultSubmenu();
    });
    addTabDefaultSubmenu.addEventListener('mouseenter', () => clearAddTabHoverHideTimer());
    addTabDefaultSubmenu.addEventListener('mouseleave', () => scheduleHideAddTabHoverMenu());
    addTabDefaultSubmenu.querySelectorAll('.tab-add-default-option').forEach((option) => option.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const type = option.dataset.agentType;
      if (!type || agentPickerSelectionLocked) return;
      agentPickerSelectionLocked = true;
      option.classList.add('pick-feedback');
      setTimeout(() => {
        option.classList.remove('pick-feedback');
        setDefaultAgent(type);
        hideAddTabHoverMenu();
        agentPickerSelectionLocked = false;
      }, 120);
    }));
    document.addEventListener('click', (event) => {
      if (addTabButton.contains(event.target) || addTabHoverMenu.contains(event.target) || addTabDefaultSubmenu.contains(event.target)) return;
      hideAddTabHoverMenu();
    });
    window.addEventListener('resize', () => {
      if (addTabHoverMenu.classList.contains('show')) positionAddTabHoverMenu();
      if (addTabDefaultSubmenu.classList.contains('show')) positionAddTabDefaultSubmenu();
    });
  }
  document.getElementById('agent-picker')?.addEventListener('click', (event) => {
    if (event.target.id === 'agent-picker') hideAgentPicker();
  });
  document.querySelectorAll('#agent-picker .agent-option').forEach((option) => option.addEventListener('click', () => {
    const type = option.dataset.agentType;
    if (!type || agentPickerSelectionLocked) return;
    agentPickerSelectionLocked = true;
    option.classList.add('pick-feedback');
    setTimeout(() => {
      option.classList.remove('pick-feedback');
      hooks.addAgentTab(type);
    }, 180);
  }));
}
