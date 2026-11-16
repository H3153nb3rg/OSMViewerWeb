// Application state: open files (workspace), selection, undo history, settings.
// A tiny event emitter keeps UI modules decoupled from each other.
//
// Several files can be open at once. Exactly one is *active*: `state.doc` is
// its document and all editing commands work on it. Other files are shown on
// the map for comparison; items can be copied or moved between files.
// A file opened with "Vergleichen" is *temporary*: marked as such, never
// nagging about unsaved changes — meant for checking what is worth taking over.
import { newDoc } from '../core/gpx.js';
import { transferItems } from '../core/ops.js';
import { DEFAULT_SERVICES } from '../services/config.js';

const SETTINGS_KEY = 'osmviewer-web.settings.v1';
const DRAFT_KEY = 'osmviewer-web.draft.v2';
const UNDO_LIMIT = 40;

const defaults = {
  baseId: 'osm', overlayId: '', coordFormat: 'dd', routingProfile: 'car',
  services: { ...DEFAULT_SERVICES }, customSources: [], view: null, showLabels: true,
  grid: 'none',             // 'none' | 'grid' | 'corners' | 'both' — coordinate grid on the map, in coordFormat
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...defaults, ...s, services: { ...DEFAULT_SERVICES, ...(s.services || {}) } };
  } catch { return { ...defaults }; }
}

const listeners = {};
export function on(event, fn) { (listeners[event] || (listeners[event] = [])).push(fn); }
export function emit(event, arg) { (listeners[event] || []).forEach((fn) => fn(arg)); }

let fileCounter = 0;
function makeFile(doc, name, { handle = null, temp = false } = {}) {
  const n = fileCounter++;
  const tag = String.fromCharCode(65 + (n % 26)) + (n >= 26 ? Math.floor(n / 26) : '');
  return { id: 'f' + (n + 1), tag, name: name || 'unbenannt.gpx', handle, doc, dirty: false, visible: true, temp };
}
export const isEmptyDoc = (d) => !d.waypoints.length && !d.routes.length && !d.tracks.length;

const first = makeFile(newDoc());
export const state = {
  files: [first],
  activeId: first.id,
  selection: null,          // {type: 'waypoint'|'route'|'track', id, segIndex?, pointIndex?} — always in the active file
  hidden: new Set(),        // ids of invisible items (ids are unique across files)
  tool: 'select',           // 'select' | 'waypoint' | 'route'
  preview: null,            // {segments: [points[]], color} temporary geometry (optimizer preview)
  printPages: null,         // page rectangles shown while the print dialog is open
  marker: null,             // {lat, lon, label} search result — a temporary mark, not part of any file
  nav: { start: null, end: null }, // {lat, lon, name} picked for "Route von hier / hierher"
  hoverPoint: null,         // {lat, lon} from the elevation profile
  cursor: null,             // {lat, lon} under the mouse while a drawing tool is active
  localServer: null,        // /api/info of serve.mjs when the disk cache is available
  archives: [],             // tile sources that exist only in the local cache
  workId: first.id,         // last active non-temporary file: target of comparisons and transfers
  version: 0,               // bumped on every change (cache key for comparisons)
  settings: loadSettings(),
  undoStack: [], redoStack: [],
  get active() { return this.files.find((f) => f.id === this.activeId) || this.files[0]; },
  get doc() { return this.active.doc; }, set doc(d) { this.active.doc = d; },
  get fileName() { return this.active.name; }, set fileName(v) { this.active.name = v; },
  get fileHandle() { return this.active.handle; }, set fileHandle(v) { this.active.handle = v; },
  get dirty() { return this.active.dirty; }, set dirty(v) { this.active.dirty = v; },
};

export function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* storage unavailable */ }
  emit('settings');
}

export const fileById = (id) => state.files.find((f) => f.id === id) || null;
function setActive(id) { state.activeId = id; const f = fileById(id); if (f && !f.temp) state.workId = id; }
/** The file that contains the item with this id. */
export function fileOfItem(itemId) {
  return state.files.find((f) => [...f.doc.waypoints, ...f.doc.routes, ...f.doc.tracks].some((x) => x.id === itemId)) || null;
}

// --- undo ----------------------------------------------------------------------
const snapshot = (fileIds) => ({
  docs: fileIds.map((id) => fileById(id)).filter(Boolean).map((f) => ({ id: f.id, doc: structuredClone(f.doc), dirty: f.dirty })),
  selection: state.selection && { ...state.selection }, activeId: state.activeId,
});

/**
 * Record an undo step, then run fn(activeDoc), which may mutate in place.
 * fileIds lists every file fn touches (default: the active one).
 */
export function mutate(label, fn, fileIds = [state.activeId]) {
  state.undoStack.push({ label, ...snapshot(fileIds) });
  if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
  state.redoStack.length = 0;
  fn(state.doc);
  for (const id of fileIds) { const f = fileById(id); if (f) f.dirty = true; }
  changed(false);
}
/** Notify after in-place changes that belong to the current undo step (e.g. while dragging). */
export function changed(markDirty = true) { if (markDirty) state.dirty = true; state.version++; emit('change'); scheduleDraft(); }

function restore(from, to) {
  const step = from.pop();
  if (!step) return;
  to.push({ label: step.label, ...snapshot(step.docs.map((d) => d.id)) });
  for (const d of step.docs) { const f = fileById(d.id); if (f) { f.doc = d.doc; f.dirty = true; } }
  if (fileById(step.activeId)) setActive(step.activeId);
  state.selection = step.selection && findItem(step.selection) ? step.selection : null;
  changed(false); emit('select');
}
export const undo = () => restore(state.undoStack, state.redoStack);
export const redo = () => restore(state.redoStack, state.undoStack);

// --- files ---------------------------------------------------------------------
/**
 * Add a file to the workspace. A pristine empty placeholder is replaced.
 * Temporary files do not take the focus away from the file being worked on.
 */
export function openFile(doc, name, { handle = null, temp = false, activate = !temp } = {}) {
  const file = makeFile(doc, name, { handle, temp });
  const only = state.files.length === 1 ? state.files[0] : null;
  if (only && isEmptyDoc(only.doc) && !only.dirty && !only.handle) { state.files = [file]; setActive(file.id); state.selection = null; }
  else {
    state.files.push(file);
    if (activate) { setActive(file.id); state.selection = null; state.preview = null; }
  }
  state.version++; emit('change'); emit('select'); scheduleDraft();
  return file;
}

export function closeFile(id) {
  const i = state.files.findIndex((f) => f.id === id);
  if (i < 0) return;
  state.files.splice(i, 1);
  if (!state.files.length) state.files.push(makeFile(newDoc()));
  if (state.activeId === id) { setActive(state.files[Math.min(i, state.files.length - 1)].id); state.selection = null; state.preview = null; }
  state.version++; emit('change'); emit('select'); scheduleDraft();
}

export function activate(id) {
  if (id === state.activeId || !fileById(id)) return;
  setActive(id); state.selection = null; state.preview = null;
  state.version++; emit('change'); emit('select');
}

/** A temporary file becomes a regular one (kept, asks before closing unsaved). */
export function keepFile(id) {
  const f = fileById(id); if (!f || !f.temp) return;
  f.temp = false; if (state.activeId === id) state.workId = id;
  state.version++; emit('change');
}

/** The file comparisons and transfers refer to: the active one unless it is temporary. */
export function workFile() {
  const a = state.active;
  if (!a.temp) return a;
  const w = fileById(state.workId);
  return w && !w.temp ? w : state.files.find((f) => !f.temp) || null;
}

/** Close everything and start with one empty file. */
export function resetWorkspace() {
  state.files = [makeFile(newDoc())]; setActive(state.files[0].id);
  state.undoStack.length = 0; state.redoStack.length = 0; state.hidden.clear();
  state.selection = null; state.preview = null;
  emit('change'); emit('select'); scheduleDraft();
}

/** Select an item; with fileId the containing file becomes the active one. */
export function select(sel, fileId) {
  if (fileId && fileId !== state.activeId && fileById(fileId)) { setActive(fileId); state.preview = null; state.selection = sel; state.version++; emit('change'); emit('select'); return; }
  state.selection = sel; emit('select');
}
export function setTool(tool) { state.tool = tool; emit('tool'); }

/** Copy or move items between two open files (one undo step). Returns the new ids in the target. */
export function transfer(itemIds, fromId, toId, { move = false } = {}) {
  const from = fileById(fromId), to = fileById(toId);
  if (!from || !to || from === to || !itemIds.length) return [];
  let newIds = [];
  mutate(move ? 'Verschieben in andere Datei' : 'Übernehmen in andere Datei', () => {
    const r = transferItems(from.doc, to.doc, itemIds, { move, sourceName: from.name });
    to.doc = r.dst; if (move) from.doc = r.src; newIds = r.newIds;
  }, move ? [fromId, toId] : [toId]);
  if (move && state.selection && itemIds.includes(state.selection.id)) select(null);
  return newIds;
}

/** Resolve a selection to its item (and collection) in a document (default: active). */
export function findItem(sel = state.selection, doc = state.doc) {
  if (!sel) return null;
  const list = sel.type === 'waypoint' ? doc.waypoints : sel.type === 'route' ? doc.routes : doc.tracks;
  const index = list.findIndex((x) => x.id === sel.id);
  return index < 0 ? null : { item: list[index], list, index, type: sel.type };
}

// --- crash-safe draft in localStorage (small workspaces only) --------------------
let draftTimer = 0;
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => emit('draft'), 1500);
}
/** entries: [{name, text, dirty, temp, active}] or null to clear. */
export function writeDraft(entries) {
  try {
    if (entries && entries.length && entries.reduce((n, e) => n + e.text.length, 0) < 4e6) localStorage.setItem(DRAFT_KEY, JSON.stringify(entries));
    else localStorage.removeItem(DRAFT_KEY);
  } catch { /* quota */ }
}
export function readDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; } }
