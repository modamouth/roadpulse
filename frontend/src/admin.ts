// Moderator review UI (admin.html). Signs a moderator in (password or magic
// link), lists incidents by moderation state (Pending / Approved / Rejected,
// filterable by source), approves/rejects pending ones via review_incident(),
// and places map pins via set_incident_location(). All enforcement is
// server-side (RLS + the checks in those functions); this page only decides
// what to show.
import L from 'leaflet';
import type { Session } from '@supabase/supabase-js';
import {
  fetchModerationCounts,
  fetchModerationList,
  fetchReviewerEmails,
  reopenIncident,
  reviewIncident,
  setIncidentLocation,
  type EntryType,
  type ReviewItem,
  type ReviewStatus,
} from './api/client';
import { getSession, isModerator, onSessionChange, sendMagicLink, signInWithPassword, signOut } from './api/auth';
import { addBasemap } from './map/basemap';
import { esc, safeUrl } from './lib/html';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const map = L.map('map', { zoomControl: true }).setView([-22.5, 17.3], 6);
addBasemap(map);
const listLayer = L.layerGroup().addTo(map);
const markers = new Map<number, L.CircleMarker>();

const MARKER_STYLE: Record<ReviewStatus, L.CircleMarkerOptions> = {
  pending: { radius: 9, color: '#3987e5', weight: 2, dashArray: '3 3', fillColor: '#3987e5', fillOpacity: 0.25 },
  approved: { radius: 8, color: '#fff', weight: 2, fillColor: '#3987e5', fillOpacity: 0.95 },
  rejected: { radius: 7, color: '#898781', weight: 1.5, fillColor: '#898781', fillOpacity: 0.2 },
};

let status: ReviewStatus = 'pending';
let entryFilter: EntryType | undefined;
let items: ReviewItem[] = [];
let reviewers = new Map<string, string>();
let myUserId: string | null = null;

function setStatus(text: string, kind: 'info' | 'error' = 'info') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Auth -----------------------------------------------------------------

async function withButtonsDisabled(fn: () => Promise<void>) {
  const buttons = $('signInForm').querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (err) {
    setStatus(errorText(err), 'error');
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

$<HTMLFormElement>('signInForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = $<HTMLInputElement>('email').value.trim();
  const password = $<HTMLInputElement>('password').value;
  if (!email) return;
  if (!password) {
    setStatus('Enter your password, or use the email sign-in link below.', 'error');
    return;
  }
  // On success, onAuthStateChange → renderSession takes over.
  void withButtonsDisabled(async () => {
    setStatus('Signing in…');
    await signInWithPassword(email, password);
    $<HTMLInputElement>('password').value = '';
  });
});

$('magicLinkBtn').addEventListener('click', () => {
  const email = $<HTMLInputElement>('email').value.trim();
  if (!email) {
    setStatus('Enter your email first.', 'error');
    return;
  }
  void withButtonsDisabled(async () => {
    // With shouldCreateUser: false, an unknown email errors here.
    await sendMagicLink(email);
    setStatus(`Sign-in link sent to ${email}. Open it in this browser.`);
  });
});

$('signOutBtn').addEventListener('click', () => {
  signOut().catch((err) => setStatus(errorText(err), 'error'));
});

let renderedFor: string | null | undefined;

async function renderSession(session: Session | null) {
  // onAuthStateChange also fires on token refresh; don't reload the list
  // (and lose a half-typed note) unless the user actually changed.
  const userId = session?.user.id ?? null;
  if (userId === renderedFor) return;
  renderedFor = userId;
  myUserId = userId;

  $('signInForm').hidden = !!session;
  $('signedIn').hidden = !session;
  $('queueSection').hidden = true;
  cancelPin();
  clearList();

  if (!session) {
    setStatus('');
    return;
  }

  $('userEmail').textContent = session.user.email ?? session.user.id;
  try {
    if (!(await isModerator())) {
      setStatus("This account isn't a moderator. An admin has to promote it in the database (see schema.sql).", 'error');
      return;
    }
    setStatus('');
    $('queueSection').hidden = false;
    await refresh();
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

// --- Tabs / filter --------------------------------------------------------

$('statusTabs').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-status]');
  if (!btn || btn.dataset.status === status) return;
  document.querySelectorAll('#statusTabs button').forEach((b) => b.classList.toggle('active', b === btn));
  status = btn.dataset.status as ReviewStatus;
  cancelPin();
  void refresh();
});

$<HTMLSelectElement>('entryFilter').addEventListener('change', (e) => {
  entryFilter = ((e.target as HTMLSelectElement).value || undefined) as EntryType | undefined;
  cancelPin();
  void refresh();
});

async function refresh() {
  try {
    const [list, counts] = await Promise.all([fetchModerationList(status, entryFilter), fetchModerationCounts(entryFilter)]);
    items = list;
    for (const [s, n] of Object.entries(counts)) {
      const el = document.querySelector(`[data-count="${s}"]`);
      if (el) el.textContent = String(n);
    }
    const reviewerIds = [...new Set(items.map((i) => i.reviewed_by).filter((id): id is string => !!id))];
    reviewers = await fetchReviewerEmails(reviewerIds);
    renderList();
  } catch (err) {
    setStatus(errorText(err), 'error');
  }
}

// --- List rendering -------------------------------------------------------

function clearList() {
  items = [];
  $('queue').replaceChildren();
  listLayer.clearLayers();
  markers.clear();
}

function formatOccurred(item: ReviewItem): string {
  if (!item.occurred_at) return 'unknown';
  const d = new Date(item.occurred_at);
  const text = item.occurred_at_precision === 'exact' ? d.toLocaleString() : d.toLocaleDateString();
  return item.occurred_at_precision && item.occurred_at_precision !== 'exact'
    ? `${text} (${item.occurred_at_precision.replace('_', ' ')})`
    : text;
}

function row(label: string, value: string | null | undefined): string {
  if (value == null || value === '') return '';
  return `<div class="popup-row"><span class="k">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;
}

function hasCoords(item: ReviewItem): boolean {
  return item.lat != null && item.lng != null;
}

function reviewerLabel(item: ReviewItem): string {
  if (!item.reviewed_by) return 'unknown';
  if (item.reviewed_by === myUserId) return 'you';
  return reviewers.get(item.reviewed_by) ?? 'a former moderator';
}

function footerHtml(item: ReviewItem): string {
  const pinLabel = hasCoords(item) ? 'Move pin' : 'Set location';
  const pinPanel = `
    <div class="pin-panel" hidden>
      <div class="pin-coords">Click the map to place the pin, then drag to adjust.</div>
      <textarea class="text-input pin-note" rows="2" placeholder="How was this spot chosen? (required — e.g. 'bridge on Western Bypass between Hakahana and China Town, matched on satellite imagery')"></textarea>
      <div class="card-actions">
        <button class="btn ghost" data-action="pin-cancel" type="button">Cancel</button>
        <button class="btn primary" data-action="pin-save" type="button" disabled>Save pin</button>
      </div>
    </div>`;

  if (item.needs_review) {
    return `
      ${pinPanel}
      <textarea class="text-input note" rows="2" placeholder="Review note (optional — say why if rejecting)"></textarea>
      <div class="card-actions">
        <button class="btn ghost" data-action="pin" type="button">${pinLabel}</button>
        <span class="spacer"></span>
        <button class="btn danger" data-action="reject" type="button">Reject</button>
        <button class="btn primary" data-action="approve" type="button">Approve &amp; publish</button>
      </div>`;
  }

  const meta = `
    <div class="review-meta">
      <b>${item.verified ? 'Approved' : 'Rejected'}</b> by ${esc(reviewerLabel(item))}${
        item.reviewed_at ? ` · ${esc(new Date(item.reviewed_at).toLocaleString())}` : ''
      }
      ${item.review_note ? `<div class="review-note">“${esc(item.review_note)}”</div>` : ''}
      ${item.verified && !hasCoords(item) ? '<div class="review-warn">No coordinates — counted, but not shown on the public map until a location is set.</div>' : ''}
    </div>`;

  const reopenPanel = `
    <div class="reopen-panel" hidden>
      <textarea class="text-input reopen-note" rows="2" placeholder="Why send this back to pending? (required)"></textarea>
      <div class="card-actions">
        <button class="btn ghost" data-action="reopen-cancel" type="button">Cancel</button>
        <button class="btn primary" data-action="reopen-confirm" type="button" disabled>Send back to pending</button>
      </div>
    </div>`;

  return `
    ${meta}
    ${item.verified ? pinPanel : ''}
    ${reopenPanel}
    <div class="card-actions main-actions">
      ${item.verified ? `<button class="btn ghost" data-action="pin" type="button">${pinLabel}</button>` : ''}
      <span class="spacer"></span>
      <button class="btn ghost" data-action="reopen" type="button">Send back to pending</button>
    </div>`;
}

function cardHtml(item: ReviewItem): string {
  const source = safeUrl(item.source_url);
  const injuries = item.injuries_count != null ? String(item.injuries_count) : item.injuries_description;
  const coords = hasCoords(item) ? `${Number(item.lat).toFixed(4)}, ${Number(item.lng).toFixed(4)}` : null;

  return `
    <div class="card-head">
      <div class="card-title">${esc(item.accident_type ?? 'Incident')} — ${esc(item.road ?? 'unknown road')}</div>
      <div class="badges">
        <span class="badge">${esc(item.entry_type)}</span>
        ${item.is_synthetic ? '<span class="badge warn">synthetic</span>' : ''}
      </div>
    </div>
    ${row('Occurred', formatOccurred(item))}
    ${row('Location (as reported)', item.location_description)}
    ${row('Coordinates', coords ?? 'none — not on map')}
    ${row('Geocoded by', item.geocode_method ?? 'not geocoded')}
    ${row('Region', item.region)}
    ${row('Vehicles', item.vehicles_involved?.join(', '))}
    ${row('Fatalities', item.fatalities != null ? String(item.fatalities) : null)}
    ${row('Injuries', injuries)}
    <div class="popup-row"><span class="k">Source</span><span class="v">${
      source
        ? `<a href="${esc(source)}" target="_blank" rel="noopener noreferrer">${esc(item.source_name ?? source)}</a>`
        : esc(item.source_name ?? '—')
    }</span></div>
    ${
      item.confidence_notes?.length
        ? `<div class="flags"><div class="flags-title">Flags to check</div><ul>${item.confidence_notes
            .map((n) => `<li>${esc(n)}</li>`)
            .join('')}</ul></div>`
        : ''
    }
    <div class="card-meta">Added ${esc(new Date(item.created_at).toLocaleString())} · #${item.id}</div>
    ${footerHtml(item)}
    <div class="card-error" role="alert"></div>`;
}

function renderList() {
  const list = $('queue');
  list.replaceChildren();
  listLayer.clearLayers();
  markers.clear();

  if (items.length === 0) {
    const empty = { pending: 'Nothing waiting for review.', approved: 'Nothing approved yet.', rejected: 'Nothing rejected.' }[status];
    list.innerHTML = `<div class="empty">${empty}</div>`;
    return;
  }

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'review-card';
    card.dataset.id = String(item.id);
    card.innerHTML = cardHtml(item);
    card.addEventListener('click', (e) => void onCardClick(e, item, card));
    card.querySelector<HTMLTextAreaElement>('.pin-note')?.addEventListener('input', () => updatePinSaveState(card));
    card.querySelector<HTMLTextAreaElement>('.reopen-note')?.addEventListener('input', (e) => {
      card.querySelector<HTMLButtonElement>('[data-action="reopen-confirm"]')!.disabled = !(e.target as HTMLTextAreaElement).value.trim();
    });
    list.appendChild(card);

    if (hasCoords(item)) {
      const marker = L.circleMarker([Number(item.lat), Number(item.lng)], MARKER_STYLE[status])
        .bindTooltip(`#${item.id} · ${esc(item.road ?? 'unknown road')}`)
        .on('click', () => selectCard(item.id, true));
      marker.addTo(listLayer);
      markers.set(item.id, marker);
    }
  }

  const pts = [...markers.values()].map((m) => m.getLatLng());
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.4), { maxZoom: 9 });
}

function selectCard(id: number, scroll: boolean) {
  document.querySelectorAll('.review-card.selected').forEach((c) => c.classList.remove('selected'));
  const card = document.querySelector<HTMLElement>(`.review-card[data-id="${id}"]`);
  card?.classList.add('selected');
  if (scroll) card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const marker = markers.get(id);
  if (marker) map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 9), { duration: 0.6 });
}

// --- Pin mode -------------------------------------------------------------
// One incident at a time: click the map to drop a draggable pin, write a
// note on how the spot was chosen, save. Nothing is stored until Save.

type PinState = { item: ReviewItem; card: HTMLElement; marker: L.Marker | null };
let pin: PinState | null = null;

const pinIcon = L.divIcon({ className: 'pin-icon', iconSize: [18, 18], iconAnchor: [9, 9] });

function startPin(item: ReviewItem, card: HTMLElement) {
  cancelPin();
  pin = { item, card, marker: null };
  card.classList.add('pinning');
  card.querySelector<HTMLElement>('.pin-panel')!.hidden = false;
  card.querySelector<HTMLElement>('.pin-note')!.focus();
  map.getContainer().classList.add('pin-mode');
  const banner = $('pinBanner');
  banner.hidden = false;
  banner.textContent = `Placing #${item.id} — click the map where it happened.`;

  if (hasCoords(item)) {
    placePin(L.latLng(Number(item.lat), Number(item.lng)));
    map.flyTo(pin.marker!.getLatLng(), Math.max(map.getZoom(), 11), { duration: 0.6 });
  } else {
    selectCard(item.id, false);
  }
  updatePinSaveState(card);
}

function placePin(latlng: L.LatLng) {
  if (!pin) return;
  if (pin.marker) {
    pin.marker.setLatLng(latlng);
  } else {
    pin.marker = L.marker(latlng, { draggable: true, icon: pinIcon, autoPan: true }).addTo(map);
    pin.marker.on('drag', () => showPinCoords());
  }
  showPinCoords();
}

function showPinCoords() {
  if (!pin?.marker) return;
  const { lat, lng } = pin.marker.getLatLng();
  pin.card.querySelector('.pin-coords')!.textContent = `Pin at ${lat.toFixed(5)}, ${lng.toFixed(5)} — drag to adjust.`;
  updatePinSaveState(pin.card);
}

function updatePinSaveState(card: HTMLElement) {
  const save = card.querySelector<HTMLButtonElement>('[data-action="pin-save"]');
  if (!save) return;
  const note = card.querySelector<HTMLTextAreaElement>('.pin-note')!.value.trim();
  save.disabled = !(pin && pin.card === card && pin.marker && note);
}

function cancelPin() {
  if (!pin) return;
  pin.marker?.remove();
  pin.card.classList.remove('pinning');
  const panel = pin.card.querySelector<HTMLElement>('.pin-panel');
  if (panel) panel.hidden = true;
  pin = null;
  map.getContainer().classList.remove('pin-mode');
  $('pinBanner').hidden = true;
}

map.on('click', (e: L.LeafletMouseEvent) => {
  if (pin) placePin(e.latlng);
});

async function savePin() {
  if (!pin?.marker) return;
  const { item, card } = pin;
  const { lat, lng } = pin.marker.getLatLng();
  const note = card.querySelector<HTMLTextAreaElement>('.pin-note')!.value.trim();
  if (
    item.verified &&
    !window.confirm(`#${item.id} is published — this ${hasCoords(item) ? 'moves' : 'adds'} its point on the public map. Continue?`)
  ) {
    return;
  }

  const buttons = card.querySelectorAll<HTMLButtonElement>('button');
  buttons.forEach((b) => (b.disabled = true));
  card.querySelector('.card-error')!.textContent = '';
  try {
    await setIncidentLocation(item.id, lat, lng, note);
    cancelPin();
    setStatus(`#${item.id} pinned at ${lat.toFixed(5)}, ${lng.toFixed(5)}${item.verified ? ' — now on the public map' : ''}.`);
    await refresh();
  } catch (err) {
    card.querySelector('.card-error')!.textContent = errorText(err);
    buttons.forEach((b) => (b.disabled = false));
    updatePinSaveState(card);
  }
}

// --- Card actions ---------------------------------------------------------

async function onCardClick(e: MouseEvent, item: ReviewItem, card: HTMLElement) {
  const target = e.target as HTMLElement;
  const action = target.closest<HTMLButtonElement>('button[data-action]')?.dataset.action;
  if (!action) {
    if (!target.closest('textarea, a')) selectCard(item.id, false);
    return;
  }

  if (action === 'pin') return startPin(item, card);
  if (action === 'pin-cancel') return cancelPin();
  if (action === 'pin-save') return savePin();
  if (action === 'reopen' || action === 'reopen-cancel') {
    const open = action === 'reopen';
    if (open) cancelPin();
    card.querySelector<HTMLElement>('.reopen-panel')!.hidden = !open;
    card.querySelector<HTMLElement>('.main-actions')!.hidden = open;
    if (open) card.querySelector<HTMLTextAreaElement>('.reopen-note')!.focus();
    return;
  }
  if (action === 'reopen-confirm') return confirmReopen(item, card);

  const approve = action === 'approve';
  const note = card.querySelector<HTMLTextAreaElement>('textarea.note')!.value;
  if (approve) {
    const msg = hasCoords(item)
      ? `Publish #${item.id} to the public map?`
      : `#${item.id} has no coordinates, so it won't appear on the public map until a location is set. Approve anyway?`;
    if (!window.confirm(msg)) return;
  }

  const buttons = card.querySelectorAll<HTMLButtonElement>('button');
  buttons.forEach((b) => (b.disabled = true));
  card.querySelector('.card-error')!.textContent = '';
  try {
    await reviewIncident(item.id, approve, note);
    if (pin?.item.id === item.id) cancelPin();
    setStatus(`#${item.id} ${approve ? 'approved' : 'rejected'}.`);
    await refresh();
  } catch (err) {
    card.querySelector('.card-error')!.textContent = errorText(err);
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function confirmReopen(item: ReviewItem, card: HTMLElement) {
  const note = card.querySelector<HTMLTextAreaElement>('.reopen-note')!.value.trim();
  if (!note) return;
  if (item.verified && !window.confirm(`#${item.id} will be removed from the public map until it's approved again. Continue?`)) return;

  const buttons = card.querySelectorAll<HTMLButtonElement>('button');
  buttons.forEach((b) => (b.disabled = true));
  card.querySelector('.card-error')!.textContent = '';
  try {
    await reopenIncident(item.id, note);
    setStatus(`#${item.id} sent back to pending${item.verified ? ' — removed from the public map' : ''}.`);
    await refresh();
  } catch (err) {
    card.querySelector('.card-error')!.textContent = errorText(err);
    buttons.forEach((b) => (b.disabled = false));
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pin) cancelPin();
});

$('mobileToggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));

// --- Boot -----------------------------------------------------------------

onSessionChange((session) => void renderSession(session));
getSession()
  .then(renderSession)
  .catch((err) => setStatus(errorText(err), 'error'));
