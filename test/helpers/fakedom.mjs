// Tiny DOM stand-in so the UI modules can be exercised under `node --test`
// without a browser or third-party packages. It implements only what the app
// uses: element tree, attributes, events, simple CSS selectors, canvas stubs.
import { readFileSync } from 'node:fs';
import { parseXml } from '../../src/core/xml.js';

class TextNode { constructor(t) { this.data = String(t); this.parentNode = null; } get textContent() { return this.data; } }

function parseCompound(sel) {
  const parts = { tag: null, id: null, classes: [], attrs: [], nots: [] };
  let s = sel, m;
  while (s.length) {
    if ((m = /^:not\(([^)]*)\)/.exec(s))) parts.nots.push(parseCompound(m[1]));
    else if ((m = /^#([\w-]+)/.exec(s))) parts.id = m[1];
    else if ((m = /^\.([\w-]+)/.exec(s))) parts.classes.push(m[1]);
    else if ((m = /^\[([\w-]+)(?:([\^$*]?=)"?([^"\]]*)"?)?\]/.exec(s))) parts.attrs.push({ name: m[1], op: m[2], value: m[3] });
    else if ((m = /^[\w-]+/.exec(s))) parts.tag = m[0].toUpperCase();
    else throw new Error('fakedom: unsupported selector ' + sel);
    s = s.slice(m[0].length);
  }
  return parts;
}
function matchesCompound(el, p) {
  if (p.tag && el.tagName !== p.tag) return false;
  if (p.id && el.id !== p.id) return false;
  if (!p.classes.every((c) => el.classList.contains(c))) return false;
  for (const a of p.attrs) {
    let v = el.getAttribute(a.name);
    if (v === null && ['open', 'hidden', 'disabled', 'checked'].includes(a.name) && el[a.name]) v = '';
    if (v === null) return false;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
  }
  return !p.nots.some((n) => matchesCompound(el, n));
}

export class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.attributes = {}; this.childNodes = []; this.parentNode = null;
    this.listeners = {}; this.style = {}; this._value = undefined;
    const self = this;
    this.dataset = new Proxy({}, { set(_, k, v) { self.attributes['data-' + k] = String(v); return true; }, get(_, k) { return self.attributes['data-' + String(k)]; } });
    this.classList = { contains: (c) => self.className.split(/\s+/).includes(c), add: (c) => { if (!self.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); },
      remove: (c) => { self.className = self.className.split(/\s+/).filter((x) => x !== c).join(' '); } };
  }
  get id() { return this.attributes.id || ''; } set id(v) { this.attributes.id = v; }
  get className() { return this.attributes.class || ''; } set className(v) { this.attributes.class = v; }
  get hidden() { return 'hidden' in this.attributes; } set hidden(v) { if (v) this.attributes.hidden = ''; else delete this.attributes.hidden; }
  get children() { return this.childNodes.filter((c) => c instanceof Element); }
  get value() {
    if (this.tagName === 'SELECT' && this._value === undefined) { const o = this.children.find((c) => c.selected) || this.children[0]; return o ? o.value || o.textContent : ''; }
    return this._value ?? this.attributes.value ?? '';
  }
  set value(v) { this._value = String(v); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(t) { this.replaceChildren(); if (t !== '') this.append(String(t)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  append(...nodes) {
    for (let n of nodes) {
      if (!(n instanceof Element) && !(n instanceof TextNode)) n = new TextNode(n);
      if (n.parentNode) n.parentNode.childNodes = n.parentNode.childNodes.filter((c) => c !== n);
      n.parentNode = this; this.childNodes.push(n);
    }
  }
  replaceChildren(...nodes) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...nodes); }
  remove() { if (this.parentNode) { this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this); this.parentNode = null; } }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) { ev.target = ev.target || this; for (const fn of (this.listeners[ev.type] || []).slice()) fn(ev); return true; }
  /** Test helper: fire an event with defaults. */
  fire(type, props = {}) { const ev = { type, target: this, preventDefault() {}, stopPropagation() {}, ...props }; this.dispatchEvent(ev); return ev; }
  click() { this.fire('click'); }
  focus() { globalThis.document.activeElement = this; }
  scrollIntoView() {} setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this._w ?? 900, height: this._h ?? 600 }; }
  getContext() { return this._ctx || (this._ctx = makeContext()); }
  toBlob(cb) { cb(new Blob(['png'])); }
  toDataURL(type = 'image/png') { return `data:${type};base64,AAAA`; }
  showModal() { this.open = true; } show() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.fire('close'); }
  matches(sel) { return sel.split(',').some((s) => { const chain = s.trim().split(/\s+(?![^\[]*\])/).map(parseCompound); return matchChain(this, chain); }); }
  *descendants() { for (const c of this.children) { yield c; yield* c.descendants(); } }
  querySelectorAll(sel) { return [...this.descendants()].filter((e) => e.matches(sel)); }
  querySelector(sel) { for (const e of this.descendants()) if (e.matches(sel)) return e; return null; }
}
function matchChain(el, chain) {
  if (!matchesCompound(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let p = el.parentNode; p && i >= 0; p = p.parentNode) if (p instanceof Element && matchesCompound(p, chain[i])) i--;
  return i < 0;
}

/** Canvas 2D context that accepts every call and records how often each method ran. */
export function makeContext() {
  const calls = {}, texts = []; // texts: everything drawn with fillText
  return new Proxy({ calls, texts }, {
    get(t, k) {
      if (k === 'calls') return calls;
      if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
      if (typeof k === 'symbol') return undefined;
      if (k in t) return t[k];
      return (...a) => { calls[k] = (calls[k] || 0) + 1; if (k === 'fillText') texts.push(String(a[0])); if (k === 'drawImage' && !a[0]) throw new Error('drawImage without image'); };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function build(node, doc) {
  const el = doc.createElement(node.name);
  for (const [k, v] of Object.entries(node.attrs)) el.setAttribute(k, v);
  for (const c of node.children) el.append(typeof c === 'string' ? c : build(c, doc));
  return el;
}

/** Install globals (document, window, Image, ...) from the app's real index.html. */
export function installDom(indexHtmlUrl, { tileDelayMs = 0, failTiles = false } = {}) {
  const html = readFileSync(indexHtmlUrl, 'utf8')
    .replace(/<!doctype[^>]*>/i, '').replace(/<(meta|link|input)\b([^>]*?)\/?>/g, '<$1$2/>')
    .replace(/\s(hidden|multiple)(?=[\s>/])/g, ' $1=""').replace(/<noscript>[\s\S]*?<\/noscript>/, '');
  const document = {
    activeElement: null, title: '',
    createElement: (t) => new Element(t), createTextNode: (t) => new TextNode(t),
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); },
    fire(type, props = {}) { const ev = { type, target: document.body, preventDefault() {}, stopPropagation() {}, ...props }; for (const fn of (this.listeners[type] || []).slice()) fn(ev); return ev; },
  };
  const root = build(parseXml(html), document);
  document.documentElement = root;
  document.body = root.children.find((c) => c.tagName === 'BODY');
  document.querySelector = (s) => root.querySelector(s);
  document.querySelectorAll = (s) => root.querySelectorAll(s);
  const store = new Map();
  const win = {
    document, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800, listeners: {}, printed: 0,
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
    fire(type, props = {}) { const ev = { type, preventDefault() {}, ...props }; for (const fn of (this.listeners[type] || []).slice()) fn(ev); return ev; },
    print() { this.printed++; },
  };
  const tiles = [];
  class Image { set src(v) { this._src = v; tiles.push(v); setTimeout(() => (failTiles ? this.onerror && this.onerror() : this.onload && this.onload()), tileDelayMs); } get src() { return this._src; } }
  Object.assign(globalThis, {
    document, window: win, Node: Object, Image,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    ResizeObserver: class { observe() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  });
  globalThis.Node = class {}; // `instanceof Node` is replaced below
  Object.defineProperty(globalThis.Node, Symbol.hasInstance, { value: (x) => x instanceof Element || x instanceof TextNode });
  for (const k of ['addEventListener', 'devicePixelRatio', 'innerWidth', 'innerHeight', 'print']) if (!(k in globalThis)) globalThis[k] = typeof win[k] === 'function' ? win[k].bind(win) : win[k];
  return { document, window: win, tiles, storage: store };
}
