export function showInputModal({ title, placeholder = '', defaultValue = '' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'input-modal-overlay';
    overlay.innerHTML = `
      <div class="input-modal-inner">
        <h3>${title}</h3>
        <input type="text" placeholder="${placeholder}">
        <div class="input-modal-actions">
          <button type="button" class="input-modal-cancel">Cancel</button>
          <button type="button" class="input-modal-ok">OK</button>
        </div>
      </div>
    `;
    const input = overlay.querySelector('input');
    const finish = (value) => {
      overlay.remove();
      resolve(value === null ? null : value.trim());
    };

    input.value = defaultValue;
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish(null);
    });
    overlay.querySelector('.input-modal-cancel').addEventListener('click', () => finish(null));
    overlay.querySelector('.input-modal-ok').addEventListener('click', () => finish(input.value));
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') finish(null);
      if (event.key === 'Enter') finish(input.value);
    });

    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}
