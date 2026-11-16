// Catalogue of freely usable raster tile sources (XYZ / Web Mercator, 256 px).
// No API keys, no vendor SDKs: a source is just a URL template. Users can add
// their own templates in the settings ("Eigene Kartenquelle").
//
// Template placeholders: {z} {x} {y} {s} (subdomain) {-y} (TMS row).
//
// `store` is the name of the local disk cache folder. Where the legacy Java
// application used the same tile server, its store name is reused so that
// tiles migrated with tools/MapCacheExport.java are found again.

export const TILE_SOURCES = [
  { id: 'osm', name: 'OpenStreetMap', store: 'Mapnik', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19,
    attribution: '© OpenStreetMap-Mitwirkende' },
  { id: 'osmde', name: 'OpenStreetMap DE', url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png', maxZoom: 19,
    attribution: '© OpenStreetMap-Mitwirkende' },
  { id: 'opentopo', name: 'OpenTopoMap', store: 'OpenTopoMap', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', subdomains: 'abc', maxZoom: 17,
    attribution: '© OpenStreetMap-Mitwirkende, SRTM | Darstellung: © OpenTopoMap (CC-BY-SA)' },
  { id: 'cyclosm', name: 'CyclOSM (Rad)', url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', subdomains: 'abc', maxZoom: 19,
    attribution: '© OpenStreetMap-Mitwirkende | Darstellung: CyclOSM' },
  { id: 'hot', name: 'OSM Humanitarian', url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', subdomains: 'abc', maxZoom: 19,
    attribution: '© OpenStreetMap-Mitwirkende | Darstellung: HOT' },
  { id: 'basemap-at', name: 'basemap.at (Österreich)', url: 'https://mapsneu.wien.gv.at/basemap/geolandbasemap/normal/google3857/{z}/{y}/{x}.png', maxZoom: 19,
    attribution: 'Grundkarte: basemap.at (CC-BY 4.0)' },
  { id: 'basemap-at-ortho', name: 'basemap.at Orthofoto', url: 'https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg', maxZoom: 19,
    attribution: 'Orthofoto: basemap.at (CC-BY 4.0)' },
  { id: 'usgs-topo', name: 'USGS Topo (USA)', store: 'USGS National Map Topo', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', maxZoom: 16,
    attribution: 'USGS The National Map (Public Domain)' },
  { id: 'usgs-imagery', name: 'USGS Luftbild (USA)', store: 'USGS National Map Satellite', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', maxZoom: 16,
    attribution: 'USGS The National Map (Public Domain)' },
  { id: 'esri-imagery', name: 'Esri World Imagery', store: 'ArcGISSatellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19,
    attribution: 'Quelle: Esri, Maxar, Earthstar Geographics' },
  { id: 'esri-topo', name: 'Esri World Topo', store: 'ArcGISTopoMap', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', maxZoom: 19,
    attribution: 'Quelle: Esri und Mitwirkende' },
  { id: 'esri-street', name: 'Esri World Street Map', store: 'ArcGISStreetMap', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', maxZoom: 19,
    attribution: 'Quelle: Esri und Mitwirkende' },
];

export const OVERLAY_SOURCES = [
  { id: 'wmt-hiking', name: 'Wanderwege (Waymarked Trails)', url: 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', maxZoom: 18,
    attribution: 'Wege: waymarkedtrails.org (CC-BY-SA)' },
  { id: 'wmt-cycling', name: 'Radwege (Waymarked Trails)', url: 'https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png', maxZoom: 18,
    attribution: 'Wege: waymarkedtrails.org (CC-BY-SA)' },
  { id: 'wmt-mtb', name: 'MTB-Routen (Waymarked Trails)', url: 'https://tile.waymarkedtrails.org/mtb/{z}/{x}/{y}.png', maxZoom: 18,
    attribution: 'Wege: waymarkedtrails.org (CC-BY-SA)' },
];

/**
 * Resolve a tile URL from a source template.
 * With `proxy` (base path of the local caching server, '' for same origin) catalogue
 * sources are fetched through the disk cache; custom sources always go direct.
 */
export function tileUrl(source, z, x, y, proxy = null) {
  const n = 2 ** z;
  const xx = ((x % n) + n) % n; // wrap around the antimeridian
  if (proxy !== null && !source.custom) return `${proxy}tiles/${source.id}/${z}/${xx}/${y}`;
  const sub = source.subdomains ? source.subdomains[(xx + y) % source.subdomains.length] : '';
  return source.url.replace('{z}', z).replace('{x}', xx).replace('{y}', y).replace('{-y}', n - 1 - y).replace('{s}', sub);
}

/** Cache folder name of a source (safe for every file system). */
export const storeName = (source) => String(source.store || source.id).replace(/[^A-Za-z0-9._ -]/g, '_').trim();

/**
 * Source for tiles that exist only in the local cache (e.g. migrated from the
 * legacy application, servers long gone). Served by the local backend.
 */
export function archiveSource(store, maxZoom = 19) {
  return { id: 'archive-' + store.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: 'Archiv: ' + store, store, archive: true, maxZoom,
    url: null, attribution: 'Lokales Kachelarchiv „' + store + '“' };
}

/**
 * URL actually requested by the browser. With the local backend every tile goes
 * through its disk cache (same origin, so canvas export always works); without
 * it the tile server is contacted directly and only the browser cache applies.
 */
export function requestUrl(source, z, x, y, localServer = false) {
  const n = 2 ** z, xx = ((x % n) + n) % n;
  if (source.archive) return localServer ? `/archive/${encodeURIComponent(source.store)}/${z}/${xx}/${y}` : null;
  if (localServer && !source.custom) return `/tiles/${source.id}/${z}/${xx}/${y}`;
  return tileUrl(source, z, x, y); // custom sources and hosted use: straight to the tile server
}

export function findSource(id, custom = []) {
  return [...TILE_SOURCES, ...OVERLAY_SOURCES, ...custom].find((s) => s.id === id);
}

/** Validate a user supplied template; returns a source object or throws. */
export function customSource(name, url, maxZoom = 19) {
  if (!/^https?:\/\//i.test(url) || !url.includes('{z}') || !url.includes('{x}') || !/\{-?y\}/.test(url)) {
    throw new Error('URL-Vorlage muss mit http(s):// beginnen und {z}, {x}, {y} enthalten');
  }
  return { id: 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, url, maxZoom: +maxZoom || 19, attribution: name, custom: true };
}
