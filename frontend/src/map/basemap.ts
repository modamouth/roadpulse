import L from 'leaflet';

// Standard OSM tiles, darkened in CSS (.basemap-dark in style.css). The
// prototype used CARTO's dark_all tiles, which now return an
// "API KEY REQUIRED" placeholder for every request. OSM's tile server is
// fine for development and light traffic; before a public launch, check
// https://operations.osmfoundation.org/policies/tiles/ and move to a
// self-hosted or commercial tile source if traffic warrants it.
export function addBasemap(map: L.Map): void {
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    className: 'basemap-dark',
    maxZoom: 19,
  }).addTo(map);
}
