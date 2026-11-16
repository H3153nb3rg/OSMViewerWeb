// Every external service is a plain HTTP endpoint that can be swapped for a
// self-hosted or alternative instance (Einstellungen -> Dienste). No keys.
export const DEFAULT_SERVICES = {
  // {profile} = car | bike | foot — FOSSGIS OSRM instance (same server the Java app used)
  osrm: 'https://routing.openstreetmap.de/routed-{profile}/route/v1/driving/',
  nominatim: 'https://nominatim.openstreetmap.org/',
  // Open-Meteo elevation API (Copernicus DEM GLO-90), max. 100 points per request
  elevation: 'https://api.open-meteo.com/v1/elevation',
  // Vector tiles in OpenMapTiles schema for the poster export (OpenFreeMap: free, keyless, max. zoom 14)
  vectorTiles: 'https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf',
};
