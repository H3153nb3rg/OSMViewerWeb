// Minimal, dependency-free XML reader/writer.
// Sufficient for GPX/KML: elements, attributes, text, CDATA, entities.
// Comments, processing instructions and DOCTYPE are skipped.
// Node shape: { name, attrs: {k: v}, children: [node | string] }

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

export function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}

export function parseXml(text) {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const doc = { name: '#document', attrs: {}, children: [] };
  const stack = [doc];
  const top = () => stack[stack.length - 1];
  const addText = (raw, decode) => {
    if (stack.length === 1) return; // ignore text outside root
    const t = decode ? decodeEntities(raw) : raw;
    if (!decode || /\S/.test(t)) {
      const ch = top().children;
      if (typeof ch[ch.length - 1] === 'string') ch[ch.length - 1] += t;
      else ch.push(t);
    }
  };
  const fail = (msg, pos) => {
    const line = text.slice(0, pos).split('\n').length;
    throw new Error(`XML: ${msg} (Zeile ${line})`);
  };
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { addText(text.slice(i), true); break; }
    if (lt > i) addText(text.slice(i, lt), true);
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      if (e < 0) fail('Kommentar nicht geschlossen', lt);
      i = e + 3; continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      if (e < 0) fail('CDATA nicht geschlossen', lt);
      addText(text.slice(lt + 9, e), false);
      i = e + 3; continue;
    }
    if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt + 2);
      if (e < 0) fail('Processing Instruction nicht geschlossen', lt);
      i = e + 2; continue;
    }
    if (text.startsWith('<!', lt)) { // DOCTYPE (with optional internal subset)
      let j = lt + 2, depth = 0;
      for (; j < n; j++) {
        const c = text[j];
        if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break;
      }
      i = j + 1; continue;
    }
    if (text[lt + 1] === '/') {
      const e = text.indexOf('>', lt);
      if (e < 0) fail('End-Tag nicht geschlossen', lt);
      const name = text.slice(lt + 2, e).trim();
      if (stack.length < 2 || top().name !== name) fail(`unerwartetes End-Tag </${name}>`, lt);
      stack.pop();
      i = e + 1; continue;
    }
    // start tag
    let j = lt + 1, q = null;
    for (; j < n; j++) {
      const c = text[j];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
    }
    if (j >= n) fail('Start-Tag nicht geschlossen', lt);
    let body = text.slice(lt + 1, j);
    const selfClose = body.endsWith('/');
    if (selfClose) body = body.slice(0, -1);
    const m = /^([^\s=]+)/.exec(body);
    if (!m) fail('ungültiges Tag', lt);
    const node = { name: m[1], attrs: {}, children: [] };
    const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    re.lastIndex = m[0].length;
    let a;
    while ((a = re.exec(body))) node.attrs[a[1]] = decodeEntities(a[2] !== undefined ? a[2] : a[3]);
    top().children.push(node);
    if (!selfClose) stack.push(node);
    i = j + 1;
  }
  if (stack.length !== 1) fail(`Element <${top().name}> nicht geschlossen`, n);
  const root = doc.children.find((c) => typeof c !== 'string');
  if (!root) throw new Error('XML: kein Wurzelelement');
  return root;
}

export function serializeXml(root, { indent = '  ', declaration = true } = {}) {
  const out = [];
  if (declaration) out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  const write = (node, level) => {
    const pad = indent ? indent.repeat(level) : '';
    const nl = indent ? '\n' : '';
    let open = pad + '<' + node.name;
    for (const k of Object.keys(node.attrs || {})) {
      const v = node.attrs[k];
      if (v !== undefined && v !== null) open += ` ${k}="${escapeAttr(v)}"`;
    }
    const ch = node.children || [];
    if (ch.length === 0) { out.push(open + '/>' + nl); return; }
    if (ch.every((c) => typeof c === 'string')) {
      out.push(open + '>' + escapeText(ch.join('')) + '</' + node.name + '>' + nl);
      return;
    }
    out.push(open + '>' + nl);
    for (const c of ch) {
      if (typeof c === 'string') { if (/\S/.test(c)) out.push(pad + indent + escapeText(c.trim()) + nl); }
      else write(c, level + 1);
    }
    out.push(pad + '</' + node.name + '>' + nl);
  };
  write(root, 0);
  return out.join('');
}

export const localName = (name) => { const i = name.indexOf(':'); return i < 0 ? name : name.slice(i + 1); };
export const el = (name, attrs = {}, children = []) => ({ name, attrs, children: Array.isArray(children) ? children : [children] });
export const elementChildren = (node) => node.children.filter((c) => typeof c !== 'string');
export const child = (node, local) => node.children.find((c) => typeof c !== 'string' && localName(c.name) === local);
export const childrenNamed = (node, local) => node.children.filter((c) => typeof c !== 'string' && localName(c.name) === local);
export const textOf = (node) => (node ? node.children.filter((c) => typeof c === 'string').join('').trim() : undefined);
export const childText = (node, local) => { const c = child(node, local); return c ? textOf(c) : undefined; };

/** Depth-first search for the first descendant with the given local name. */
export function findDeep(node, local) {
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    if (localName(c.name) === local) return c;
    const r = findDeep(c, local);
    if (r) return r;
  }
  return undefined;
}
