/* The quick-add window (Ctrl+Alt+N from any app): pick a project, type, Enter. */
(async function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const init = await window.cy.init();
  document.body.dataset.theme = init.theme || 'light';
  const groups = init.config.groups || [];
  $('#qItem').innerHTML = groups.map((g) => `<optgroup label="${esc(g.name)}">${g.items.map((it) => `<option value="${esc(it.id)}">${esc(it.name)}</option>`).join('')}</optgroup>`).join('');
  try { const last = localStorage.getItem('cy.quick.item'); if (last && [...$('#qItem').options].some((o) => o.value === last)) $('#qItem').value = last; } catch {}
  $('#qText').focus();
  $('#qForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#qText').value.trim();
    if (!text) return;
    try { localStorage.setItem('cy.quick.item', $('#qItem').value); } catch {}
    await window.cy.addTodo({ item: $('#qItem').value, text, focus: $('#qPin').checked });
    window.cy.quickClose();
  });
  $('#qText').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#qForm').requestSubmit(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.cy.quickClose(); });
})();
