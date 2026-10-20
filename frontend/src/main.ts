import L from 'leaflet';
import { fetchRegions, fetchIncidents, type RegionStat, type Incident } from './api/client';
import { severityColor } from './map/severity';
import { esc } from './lib/html';
import { addBasemap } from './map/basemap';

const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([-22.5, 17.3], 6);

addBasemap(map);

const regionLayer = L.layerGroup().addTo(map);
const incidentLayer = L.layerGroup().addTo(map);

let regionsCache: RegionStat[] = [];
let incidentsCache: Incident[] = [];

function currentYear(): number {
  return Number(document.getElementById('yearSeg')!.querySelector('.active')!.getAttribute('data-year'));
}

function currentMetric(): keyof RegionStat {
  return (document.getElementById('metricSelect') as HTMLSelectElement).value as keyof RegionStat;
}

function metricValue(r: RegionStat, metric: keyof RegionStat): number {
  const v = r[metric];
  return typeof v === 'number' ? v : 0;
}

function renderRegions() {
  regionLayer.clearLayers();
  const metric = currentMetric();
  const values = regionsCache.map((r) => metricValue(r, metric));
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);

  document.getElementById('legMin')!.textContent = Math.round(min).toLocaleString();
  document.getElementById('legMax')!.textContent = Math.round(max).toLocaleString();

  for (const r of regionsCache) {
    const val = metricValue(r, metric);
    const t = max > min ? (val - min) / (max - min) : 0.5;
    const radius = 9 + t * 24;
    const color = severityColor(t);

    const marker = L.circleMarker([r.centroid_lat, r.centroid_lng], {
      radius,
      color: 'rgba(255,255,255,0.35)',
      weight: 1.2,
      fillColor: color,
      fillOpacity: 0.78,
    });

    marker.bindPopup(
      `<b>${esc(r.region)}</b>` +
        `<div class="popup-row"><span class="k">Crashes (${r.year})</span><span class="v">${r.crashes.toLocaleString()}</span></div>` +
        `<div class="popup-row"><span class="k">Fatalities (${r.year})</span><span class="v">${r.fatalities.toLocaleString()}</span></div>` +
        `<div class="popup-row"><span class="k">Injuries (${r.year})</span><span class="v">${r.injuries.toLocaleString()}</span></div>` +
        (r.casualties_per_100000
          ? `<div class="popup-row"><span class="k">Casualties / 100k</span><span class="v">${r.casualties_per_100000}</span></div>`
          : '') +
        `<div class="popup-row"><span class="k">Pedestrian share</span><span class="v">${r.pedestrian_pct}%</span></div>` +
        `<div class="popup-row"><span class="k">Rollover share</span><span class="v">${r.rollover_pct}%</span></div>` +
        `<div class="popup-foot">Regional aggregate — marker sits at an approximate centroid, not a crash location.</div>`,
    );
    marker.addTo(regionLayer);
  }
}

function renderIncidents() {
  incidentLayer.clearLayers();
  for (const inc of incidentsCache) {
    if (inc.lat == null || inc.lng == null) continue;

    const marker = L.circleMarker([inc.lat, inc.lng], {
      radius: 8,
      color: '#fff',
      weight: 2,
      fillColor: '#3987e5',
      fillOpacity: 0.95,
    });

    // Every field escaped: approved crowdsourced reports are user-written.
    marker.bindPopup(
      `<b>${esc(inc.accident_type ?? 'Incident')} — ${esc(inc.road ?? 'unknown road')}</b>` +
        `<div class="popup-row"><span class="k">Location</span><span class="v">${esc(inc.location_description ?? '—')}</span></div>` +
        (inc.vehicles_involved
          ? `<div class="popup-row"><span class="k">Vehicles</span><span class="v">${esc(inc.vehicles_involved.join(', '))}</span></div>`
          : '') +
        (inc.fatalities != null
          ? `<div class="popup-row"><span class="k">Fatalities</span><span class="v">${esc(inc.fatalities)}</span></div>`
          : '') +
        `<div class="popup-row"><span class="k">Source</span><span class="v">${esc(inc.source_name ?? '—')}</span></div>` +
        `<div class="popup-foot">${esc(inc.entry_type)}</div>`,
    );
    marker.addTo(incidentLayer);
  }
}

function nationalTotal(metric: 'crashes' | 'fatalities' | 'injuries'): number {
  return regionsCache.reduce((sum, r) => sum + (r[metric] ?? 0), 0);
}

function renderKPIs() {
  document.getElementById('kpiYear')!.textContent = String(currentYear());
  const crashes = nationalTotal('crashes');
  const fatalities = nationalTotal('fatalities');
  const injuries = nationalTotal('injuries');

  document.getElementById('kpiCrashes')!.textContent = crashes.toLocaleString();
  document.getElementById('kpiFatalities')!.textContent = fatalities.toLocaleString();
  document.getElementById('kpiInjuries')!.textContent = injuries.toLocaleString();
  document.getElementById('kpiRatio')!.textContent = fatalities ? (crashes / fatalities).toFixed(1) : '—';
}

async function loadYear() {
  regionsCache = await fetchRegions(currentYear());
  renderRegions();
  renderKPIs();
}

async function init() {
  await loadYear();
  incidentsCache = await fetchIncidents();
  renderIncidents();
}

document.getElementById('yearSeg')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  document.querySelectorAll('#yearSeg button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  loadYear();
});

document.getElementById('metricSelect')!.addEventListener('change', renderRegions);

function wireToggle(id: string, layer: L.LayerGroup) {
  const btn = document.getElementById(id)!;
  btn.addEventListener('click', () => {
    btn.classList.toggle('on');
    if (btn.classList.contains('on')) map.addLayer(layer);
    else map.removeLayer(layer);
  });
}
wireToggle('toggleRegions', regionLayer);
wireToggle('toggleIncidents', incidentLayer);

const sidebar = document.getElementById('sidebar')!;
document.getElementById('mobileToggle')!.addEventListener('click', () => {
  sidebar.classList.toggle('open');
});

init().catch((err) => {
  console.error('Failed to load dashboard data from Supabase — check VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in frontend/.env', err);
});
