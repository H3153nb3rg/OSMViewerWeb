// Small DOM helpers: element factory, toasts, context menu, dialogs, downloads.

/** h('div', {class: 'x', onclick: fn}, child, 'text', ...) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);

/**
 * Replace an element's children, skipping null/undefined/false.
 * (The native replaceChildren() turns such values into the text "null".)
 */
export function setChildren(el, ...nodes) {
  el.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
}

let toastTimer = 0;
export function toast(message, kind = 'info', ms = 3500) {
  let el = $('#toast');
  if (!el) { el = h('div', { id: 'toast', role: 'status' }); document.body.append(el); }
  el.textContent = message; el.className = 'show ' + kind;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { el.className = ''; }, ms);
}

export function closeContextMenu() { const m = $('#ctxmenu'); if (m) m.remove(); }
/** items: [{label, action, disabled}] or '-' for a separator. */
export function contextMenu(clientX, clientY, items) {
  closeContextMenu();
  const menu = h('div', { id: 'ctxmenu', role: 'menu' }, items.map((it) => (it === '-' ? h('hr') :
    h('button', { type: 'button', role: 'menuitem', disabled: it.disabled, onclick: () => { closeContextMenu(); it.action(); } }, it.label))));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(clientX, window.innerWidth - r.width - 4) + 'px';
  menu.style.top = Math.min(clientY, window.innerHeight - r.height - 4) + 'px';
  setTimeout(() => {
    const off = (e) => { if (!menu.contains(e.target)) { closeContextMenu(); document.removeEventListener('pointerdown', off, true); } };
    document.addEventListener('pointerdown', off, true);
  });
}

/**
 * Open a dialog. modal=false gives a floating panel that leaves the map usable (live previews).
 * buttons: [{label, primary, action: () => boolean|void|Promise}] — returning false keeps the dialog open.
 * @returns {{dialog: HTMLDialogElement, close: () => void}}
 */
export function openDialog({ title, body, buttons = [], modal = true, onClose, className = '' }) {
  const dialog = h('dialog', { class: 'dlg ' + (modal ? '' : 'floating ') + className });
  const close = () => { if (dialog.open) dialog.close(); };
  const footer = h('footer', {}, buttons.map((b) => h('button', {
    type: 'button', class: b.primary ? 'primary' : '',
    onclick: async (e) => {
      e.target.disabled = true;
      try { const r = b.action ? await b.action() : undefined; if (r !== false) close(); }
      catch (err) { toast(err.message || String(err), 'error', 6000); }
      finally { e.target.disabled = false; }
    },
  }, b.label)));
  dialog.append(h('header', {}, h('h2', {}, title), h('button', { type: 'button', class: 'icon', title: 'Schließen', 'aria-label': 'Schließen', onclick: close }, '✕')), h('div', { class: 'dlg-body' }, body), footer);
  dialog.addEventListener('close', () => { dialog.remove(); if (onClose) onClose(); });
  document.body.append(dialog);
  if (modal) dialog.showModal(); else dialog.show();
  return { dialog, close };
}

export function confirmDialog(title, message, okLabel = 'OK') {
  return new Promise((resolve) => {
    let result = false;
    openDialog({ title, body: h('p', {}, message), onClose: () => resolve(result),
      buttons: [{ label: 'Nein' }, { label: okLabel, primary: true, action: () => { result = true; } }] });
  });
}

/** Labelled form row. */
export const field = (label, control, hint) => h('label', { class: 'field' }, h('span', {}, label), control, hint ? h('small', {}, hint) : null);
export const select = (options, value, onchange) => h('select', { onchange: (e) => onchange && onchange(e.target.value) },
  options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) }, text)));

export function download(fileName, text, mime = 'application/gpx+xml') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h('a', { href: url, download: fileName });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
