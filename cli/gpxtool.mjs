#!/usr/bin/env node
// Command line front end for the core library (same code as the browser app).
// Replaces the Python helpers of the legacy project (gpx_optimizer*.py, gpx_repair.py).
//
//   node cli/gpxtool.mjs info     tour.gpx
//   node cli/gpxtool.mjs optimize tour.gpx -o out.gpx [--level 3 | --tolerance 15 | --percent 30 | --count 500]
//   node cli/gpxtool.mjs repair   tour.gpx -o out.gpx [--gaps] [--sigma 3] [--split-mode] [--walk-kmh 15]
//   node cli/gpxtool.mjs merge    a.gpx b.kml ... -o out.gpx
//   node cli/gpxtool.mjs convert  in.kml -o out.gpx      (or .gpx -> .kml)
import { readFileSync, writeFileSync } from 'node:fs';
import { parseGpx, serializeGpx, pointCount, newDoc, newId } from '../src/core/gpx.js';
import { parseKml, serializeKml } from '../src/core/kml.js';
import { simplifyTrack } from '../src/core/simplify.js';
import { splitByGaps, splitByMode, removeDuplicates } from '../src/core/repair.js';
import { mergeDocs } from '../src/core/ops.js';
import { computeStats, formatDistance, formatDuration } from '../src/core/stats.js';

const [cmd, ...rest] = process.argv.slice(2);
const files = [], opt = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '-o') opt.out = rest[++i];
  else if (a.startsWith('--')) { const next = rest[i + 1]; if (next !== undefined && !next.startsWith('-')) { opt[a.slice(2)] = next; i++; } else opt[a.slice(2)] = true; }
  else files.push(a);
}
const read = (f) => { const t = readFileSync(f, 'utf8'); return /\.kml$/i.test(f) || /<kml[\s>]/i.test(t.slice(0, 2000)) ? parseKml(t) : parseGpx(t); };
const write = (doc) => {
  if (!opt.out) throw new Error('Ausgabedatei fehlt (-o datei.gpx)');
  writeFileSync(opt.out, /\.kml$/i.test(opt.out) ? serializeKml(doc) : serializeGpx(doc));
  console.log('geschrieben:', opt.out);
};
const usage = () => { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(cmd ? 1 : 0); };

try {
  if (!cmd || !files.length) usage();
  const doc = read(files[0]);
  if (cmd === 'info') {
    console.log(`${files[0]}: ${doc.waypoints.length} Wegpunkte, ${doc.routes.length} Routen, ${doc.tracks.length} Tracks`);
    for (const r of doc.routes) console.log(`  Route  "${r.name || ''}": ${r.points.length} Punkte, ${formatDistance(computeStats([r.points]).distance)}`);
    for (const t of doc.tracks) {
      const s = computeStats(t.segments.map((g) => g.points));
      console.log(`  Track  "${t.name || ''}": ${s.count} Punkte in ${t.segments.length} Segment(en), ${formatDistance(s.distance)}` +
        (s.durationMs ? `, ${formatDuration(s.durationMs)}` : '') + (s.ascent !== undefined ? `, ↑${Math.round(s.ascent)} m ↓${Math.round(s.descent)} m` : ''));
    }
  } else if (cmd === 'optimize') {
    const mode = ['tolerance', 'percent', 'count', 'multiplier', 'level'].find((m) => opt[m] !== undefined) || 'level';
    const value = opt[mode] !== undefined ? Number(opt[mode]) : 3;
    doc.tracks = doc.tracks.map((t) => {
      const r = simplifyTrack(t, { mode, value });
      console.log(`  "${t.name || 'Track'}": ${r.before} -> ${r.after} Punkte (${(100 * r.after / Math.max(1, r.before)).toFixed(1)} %)`);
      return r.track;
    });
    write(doc);
  } else if (cmd === 'repair') {
    const out = [];
    for (const t of doc.tracks) {
      let segs = t.segments.map((s) => removeDuplicates(s.points));
      if (opt.gaps) segs = segs.flatMap((s) => splitByGaps(s, { sigmaFactor: Number(opt.sigma) || 3 }));
      if (opt['split-mode']) {
        const n = { walk: 0, fast: 0 }, label = { walk: 'Zu Fuß', fast: 'Fahrzeug' };
        for (const run of segs.flatMap((s) => splitByMode(s, { walkKmh: Number(opt['walk-kmh']) || 15 }))) {
          out.push({ id: newId('t'), name: `${t.name || 'Track'} – ${label[run.mode]} ${++n[run.mode]}`, segments: [{ points: run.points }] });
        }
      } else out.push({ ...t, segments: segs.map((points) => ({ points })) });
      console.log(`  "${t.name || 'Track'}": ${pointCount(t)} Punkte, ${t.segments.length} -> ${segs.length} Segment(e)`);
    }
    doc.tracks = out;
    write(doc);
  } else if (cmd === 'merge') {
    write(files.slice(1).reduce((acc, f) => mergeDocs(acc, read(f)), doc));
  } else if (cmd === 'convert') {
    write(doc);
  } else usage();
} catch (e) { console.error('Fehler:', e.message); process.exit(1); }
