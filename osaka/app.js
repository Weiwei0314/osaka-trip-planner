'use strict';

// ─── Utilities ───────────────────────────────────────────────────────────────

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function todayStr() {
  return toDateStr(new Date());
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  const wd = ['日','一','二','三','四','五','六'][d.getDay()];
  return `${d.getMonth()+1}/${d.getDate()} (週${wd})`;
}

function formatDateRange(s, e) {
  if (!s && !e) return '未設定日期';
  if (!e || s === e) return formatDate(s);
  return `${formatDate(s)} – ${formatDate(e)}`;
}

function getDays(startDate, endDate) {
  if (!startDate || !endDate) return [];
  const days = [];
  const cur  = new Date(startDate + 'T00:00:00');
  const end  = new Date(endDate + 'T00:00:00');
  while (cur <= end) {
    days.push(toDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function tripStatus(trip) {
  if (!trip.startDate) return '';
  const now = todayStr();
  if (now < trip.startDate) return 'upcoming';
  if (trip.endDate && now > trip.endDate) return 'past';
  return 'ongoing';
}

function countdown(startDate) {
  if (!startDate) return '';
  const diff = Math.ceil((new Date(startDate + 'T00:00:00') - new Date()) / 86400000);
  if (diff < 0)  return '';
  if (diff === 0) return '今天出發！';
  if (diff === 1) return '明天出發';
  return `還有 ${diff} 天`;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function to12h(hhmm) {
  if (!hhmm) return { ampm: 'AM', hour: '9', min: '00' };
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h < 12 ? 'AM' : 'PM';
  let hour12 = h % 12; if (hour12 === 0) hour12 = 12;
  return { ampm, hour: String(hour12), min: String(m).padStart(2, '0') };
}

function from12h(ampm, hour12, min) {
  let h = Number(hour12) % 12;
  if (ampm === 'PM') h += 12;
  return `${String(h).padStart(2, '0')}:${min}`;
}

function buildDayOptions(tripId, selected) {
  const trip = DB.trip(tripId);
  let html = '<option value="">無特定日期（整個行程）</option>';
  if (!trip?.startDate || !trip?.endDate) return html;
  const WD = ['日','一','二','三','四','五','六'];
  getDays(trip.startDate, trip.endDate).forEach((day, i) => {
    const d = new Date(day + 'T00:00:00');
    const label = `第${i+1}天 · ${d.getMonth()+1}/${d.getDate()} (週${WD[d.getDay()]})`;
    html += `<option value="${esc(day)}"${selected === day ? ' selected' : ''}>${label}</option>`;
  });
  return html;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Photo Storage (IndexedDB) ────────────────────────────────────────────────
// Photos are stored as Blobs in IndexedDB, keyed by a small id. Every item's
// `photos` array only holds these ids (not the image data itself) — this is
// what lets photos live outside localStorage's ~5-10MB quota.

const PHOTO_DB_NAME    = 'trip-planner-photos';
const PHOTO_DB_VERSION = 1;
const PHOTO_STORE      = 'photos';

let _photoDbPromise = null;
function openPhotoDb() {
  if (_photoDbPromise) return _photoDbPromise;
  _photoDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(PHOTO_DB_NAME, PHOTO_DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(PHOTO_STORE)) {
        req.result.createObjectStore(PHOTO_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _photoDbPromise;
}

async function savePhotoBlob(id, blob) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readwrite');
    tx.objectStore(PHOTO_STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function loadPhotoBlob(id) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(PHOTO_STORE, 'readonly').objectStore(PHOTO_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

async function deletePhotoBlobs(ids) {
  if (!ids || !ids.length) return;
  ids.forEach(revokePhotoUrl);
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readwrite');
    const store = tx.objectStore(PHOTO_STORE);
    ids.forEach(id => store.delete(id));
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function duplicatePhotoBlobs(ids) {
  const newIds = [];
  for (const id of (ids || [])) {
    const blob = await loadPhotoBlob(id);
    if (!blob) continue;
    const newId = genId();
    await savePhotoBlob(newId, blob);
    newIds.push(newId);
  }
  return newIds;
}

// Object URLs are cached (one per photo id, reused across every re-render)
// instead of being recreated/revoked on every render — far simpler than
// tracking per-render lifecycles, and they're only released when the photo
// itself is actually deleted.
const photoUrlCache = new Map();

async function getPhotoUrl(id) {
  if (photoUrlCache.has(id)) return photoUrlCache.get(id);
  const blob = await loadPhotoBlob(id);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  photoUrlCache.set(id, url);
  return url;
}

function revokePhotoUrl(id) {
  const url = photoUrlCache.get(id);
  if (url) { URL.revokeObjectURL(url); photoUrlCache.delete(id); }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// One-time migration for data saved before this version: old items store
// photos as inline Base64 data URLs directly in localStorage. Convert each
// to a Blob in IndexedDB and replace the array entries with ids.
async function migratePhotosToIndexedDB() {
  if (localStorage.getItem('photosMigratedV1')) return;

  for (const key of ['events', 'shopping', 'todos']) {
    const list = DB._read(key);
    let changed = false;
    for (const item of list) {
      if (!item.photos || !item.photos.length) continue;
      const newIds = [];
      for (const src of item.photos) {
        if (typeof src === 'string' && src.startsWith('data:')) {
          try {
            const blob = await (await fetch(src)).blob();
            const id = genId();
            await savePhotoBlob(id, blob);
            newIds.push(id);
            changed = true;
          } catch { /* skip photo that fails to migrate */ }
        } else {
          newIds.push(src);
        }
      }
      item.photos = newIds;
    }
    if (changed) DB._write(key, list);
  }
  localStorage.setItem('photosMigratedV1', '1');
}

// ─── Data Layer (localStorage) ───────────────────────────────────────────────

const DB = {
  _read(k)    { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } },
  _write(k,v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (err) {
      alert('儲存失敗，瀏覽器儲存空間可能已滿。請刪除一些項目後再試一次。');
      throw err;
    }
  },

  // ── Trips ──
  trips()      { return this._read('trips'); },
  trip(id)     { return this.trips().find(t => t.id === id); },
  saveTrip(t)  {
    const list = this.trips();
    const idx  = list.findIndex(x => x.id === t.id);
    if (idx >= 0) list[idx] = t; else list.unshift(t);
    this._write('trips', list);
  },
  deleteTrip(id) {
    const photoIds = [
      ...this.events(id).flatMap(e => e.photos || []),
      ...this.shopping(id).flatMap(s => s.photos || []),
      ...this.todos(id).flatMap(t => t.photos || []),
    ];
    this._write('trips',     this.trips().filter(t => t.id !== id));
    this._write('events',    this._read('events').filter(e => e.tripId !== id));
    this._write('shopping',  this._read('shopping').filter(s => s.tripId !== id));
    this._write('todos',     this._read('todos').filter(t => t.tripId !== id));
    this._write('locations', this._read('locations').filter(l => l.tripId !== id));
    if (photoIds.length) deletePhotoBlobs(photoIds).catch(() => {});
  },

  // ── Events ──
  events(tripId)   { return this._read('events').filter(e => e.tripId === tripId); },
  event(id)        { return this._read('events').find(e => e.id === id); },
  saveEvent(ev)    { this._saveItem('events', ev); },
  deleteEvent(id)  {
    const photos = this.event(id)?.photos;
    this._del('events', id);
    if (photos?.length) deletePhotoBlobs(photos).catch(() => {});
  },

  // ── Shopping ──
  shopping(tripId) { return this._read('shopping').filter(s => s.tripId === tripId); },
  shopItem(id)     { return this._read('shopping').find(s => s.id === id); },
  saveShop(item)   { this._saveItem('shopping', item); },
  deleteShop(id)   {
    const photos = this.shopItem(id)?.photos;
    this._del('shopping', id);
    if (photos?.length) deletePhotoBlobs(photos).catch(() => {});
  },

  // ── Todos ──
  todos(tripId)   { return this._read('todos').filter(t => t.tripId === tripId); },
  todo(id)        { return this._read('todos').find(t => t.id === id); },
  saveTodo(todo)  { this._saveItem('todos', todo); },
  deleteTodo(id)  {
    const photos = this.todo(id)?.photos;
    this._del('todos', id);
    if (photos?.length) deletePhotoBlobs(photos).catch(() => {});
  },

  // ── Locations ──
  locations(tripId)  { return this._read('locations').filter(l => l.tripId === tripId); },
  location(id)       { return this._read('locations').find(l => l.id === id); },
  saveLoc(loc)       { this._saveItem('locations', loc); },
  deleteLoc(id)      { this._del('locations', id); },

  // ── Helpers ──
  _saveItem(key, item) {
    const list = this._read(key);
    const idx  = list.findIndex(x => x.id === item.id);
    if (idx >= 0) list[idx] = item; else list.push(item);
    this._write(key, list);
  },
  _del(key, id) {
    this._write(key, this._read(key).filter(x => x.id !== id));
  },
};

// ─── State ───────────────────────────────────────────────────────────────────

const S = {
  view:           'trips',   // 'trips' | 'detail'
  tripId:         null,
  tab:            'overview',
  modal:          null,
  editId:         null,
  pendingDate:    null,
  pendingEventId: null,
  confirmCb:      null,
  editPhotos:     [],
  copyType:       null,
  copyItemId:     null,
};

const MAX_PHOTOS_PER_ITEM = 20;

// ─── DOM Shorthand ───────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// ─── Navigation ──────────────────────────────────────────────────────────────

function openTrip(id) {
  S.view = 'detail'; S.tripId = id; S.tab = 'overview';
  render();
}

function backToTrips() {
  S.view = 'trips'; S.tripId = null;
  render();
}

async function setTab(tab) { S.tab = tab; await renderDetail(); syncTabBar(); }

// ─── Top-level Render ────────────────────────────────────────────────────────

const BACK_BTN_HTML = `
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
  返回`;

const IMPORT_BTN_HTML = `
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M4 19h16"/></svg>
  匯入`;

async function render() {
  const isDetail = S.view === 'detail';

  // Header
  $('btn-back').innerHTML = isDetail ? BACK_BTN_HTML : IMPORT_BTN_HTML;
  $('header-title').textContent = isDetail
    ? (DB.trip(S.tripId)?.name || '行程') : '我的行程';

  // Screens
  $('screen-trips').style.display  = isDetail ? 'none' : '';
  $('screen-detail').style.display = isDetail ? '' : 'none';

  // Tab bar
  $('tab-bar').style.display = isDetail ? '' : 'none';
  $('btn-import-csv').style.display = isDetail ? '' : 'none';

  if (isDetail) { await renderDetail(); syncTabBar(); }
  else          { renderTrips(); }
}

function syncTabBar() {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === S.tab);
  });
}

// ─── Trips Screen ────────────────────────────────────────────────────────────

function renderTrips() {
  const trips = DB.trips();
  const el    = $('screen-trips');

  if (!trips.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✈️</div>
        <p class="empty-title">還沒有行程</p>
        <p class="empty-desc">點右上角 + 新增你的第一個旅行計畫</p>
      </div>`;
    return;
  }

  el.innerHTML = `<div class="trips-list">${trips.map(tripCard).join('')}</div>`;
}

const STATUS_LABEL = { upcoming:'即將出發', ongoing:'旅行中', past:'已結束' };
const STATUS_CLASS = { upcoming:'status-upcoming', ongoing:'status-ongoing', past:'status-past' };

function tripCard(trip) {
  const st  = tripStatus(trip);
  const cd  = countdown(trip.startDate);
  const evs = DB.events(trip.id).length;
  const td  = DB.todos(trip.id).filter(t => !t.completed).length;

  return `
    <div class="trip-card" data-action="open-trip" data-id="${esc(trip.id)}">
      <div class="trip-card-top">
        <div>
          <div class="trip-name">${esc(trip.name)}</div>
          ${trip.destination ? `<div class="trip-destination">📍 ${esc(trip.destination)}</div>` : ''}
        </div>
        <div class="trip-card-actions">
          ${st ? `<span class="trip-status ${STATUS_CLASS[st]}">${STATUS_LABEL[st]}</span>` : ''}
          <button class="btn-icon-sm" data-action="export-trip" data-id="${esc(trip.id)}" title="分享/匯出">⬆</button>
          <button class="btn-icon-sm" data-action="delete-trip" data-id="${esc(trip.id)}">✕</button>
        </div>
      </div>
      <div class="trip-card-meta">
        <span>📅 ${formatDateRange(trip.startDate, trip.endDate)}</span>
        ${cd ? `<span class="countdown">${cd}</span>` : ''}
      </div>
      ${(evs || td) ? `
      <div class="trip-card-stats">
        ${evs ? `<span>🗺 ${evs} 個行程</span>` : ''}
        ${td  ? `<span>📋 ${td} 項代辦</span>`  : ''}
      </div>` : ''}
    </div>`;
}

// ─── Detail Screen Dispatch ───────────────────────────────────────────────────

async function renderDetail() {
  switch (S.tab) {
    case 'overview': await renderOverview(); break;
    case 'timeline': await renderTimeline(); break;
    case 'shopping': await renderShopping(); break;
    case 'todo':     await renderTodo();     break;
  }
}

// ─── Overview ────────────────────────────────────────────────────────────────

async function renderOverview() {
  const trip = DB.trip(S.tripId);
  const el   = $('screen-detail');
  if (!trip) { el.innerHTML = ''; return; }

  const events   = DB.events(S.tripId);
  const shopping = DB.shopping(S.tripId);
  const todos    = DB.todos(S.tripId);

  const heroHtml  = overviewHeroHtml(trip);
  const todoDone  = todos.filter(t => t.completed).length;
  const budget    = shopping.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);

  const statsHtml = `
    <div class="overview-stats">
      <div class="overview-stat">
        <div class="overview-stat-num">${events.length}</div>
        <div class="overview-stat-label">行程項目</div>
      </div>
      <div class="overview-stat">
        <div class="overview-stat-num">${todoDone}/${todos.length}</div>
        <div class="overview-stat-label">代辦完成</div>
      </div>
      <div class="overview-stat">
        <div class="overview-stat-num">${budget ? '¥' + budget.toLocaleString() : '—'}</div>
        <div class="overview-stat-label">購物預估</div>
      </div>
    </div>`;

  if (!events.length && !shopping.length && !todos.length) {
    el.innerHTML = `
      <div class="overview-content">
        ${heroHtml}${statsHtml}
        <div class="empty-state">
          <div class="empty-icon">🧳</div>
          <p class="empty-title">這個行程還是空的</p>
          <p class="empty-desc">切到「時間軸」開始安排行程項目吧</p>
        </div>
      </div>`;
    return;
  }

  let planHtml = '';
  let dayHtml  = '';
  if (trip.startDate && trip.endDate) {
    const st    = tripStatus(trip);
    const days  = getDays(trip.startDate, trip.endDate);
    const today = todayStr();
    const WD    = ['日','一','二','三','四','五','六'];

    // Whole-trip, day-by-day plan at a glance — separate from the "today" detail below
    const planRows = days.map((day, i) => {
      const dayEvs = events.filter(e => e.date === day)
        .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
      const d = new Date(day + 'T00:00:00');
      const label = `第${i + 1}天・${d.getMonth() + 1}/${d.getDate()}(週${WD[d.getDay()]})`;
      const preview = dayEvs.length
        ? esc(dayEvs[0].title) + (dayEvs.length > 1 ? ` 等 ${dayEvs.length} 個行程` : '')
        : '尚無安排';
      return `
        <div class="overview-day-row${day === today ? ' overview-day-today' : ''}" data-action="goto-day" data-date="${esc(day)}">
          <span class="overview-day-label">${esc(label)}</span>
          <span class="overview-day-preview">${preview}</span>
        </div>`;
    }).join('');
    planHtml = `
      <div class="day-group-header">🗓 整趟行程一覽</div>
      <div class="overview-day-list">${planRows}</div>`;

    if (st === 'ongoing' && days.includes(today)) {
      const dayIdx   = days.indexOf(today);
      const todayEvs = events.filter(e => e.date === today)
        .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
      dayHtml = `
        <div class="day-group-header">📅 今天・第 ${dayIdx + 1} 天</div>
        ${todayEvs.length
          ? `<div class="item-list">${todayEvs.map(overviewEventRow).join('')}</div>`
          : `<div class="day-empty">今天沒有安排行程</div>`}`;
    }
  }

  const pendingTodos = todos.filter(t => !t.completed).sort(sortTodos).slice(0, 5);
  const todoHtml = pendingTodos.length ? `
    <div class="day-group-header">✅ 待辦事項（未完成）</div>
    <div class="item-list">${(await Promise.all(pendingTodos.map(todoItem))).join('')}</div>` : '';

  el.innerHTML = `<div class="overview-content">${heroHtml}${statsHtml}${planHtml}${dayHtml}${todoHtml}</div>`;
}

function overviewHeroHtml(trip) {
  const st = tripStatus(trip);
  const cd = countdown(trip.startDate);
  let text;
  if (!trip.startDate || !trip.endDate) text = '📅 尚未設定旅行日期';
  else if (st === 'upcoming')           text = `✈️ ${cd || '即將出發'}`;
  else if (st === 'ongoing')            text = '🌏 旅行進行中';
  else                                  text = '🏁 行程已結束';
  return `<div class="overview-hero"><div class="overview-hero-title">${text}</div></div>`;
}

function overviewEventRow(ev) {
  const icon    = CAT_ICON[ev.category] || '📌';
  const timeStr = ev.startTime
    ? (ev.endTime ? `${ev.startTime}–${ev.endTime}` : ev.startTime)
    : '';
  return `
    <div class="list-item" data-action="edit-event" data-id="${esc(ev.id)}">
      <div class="item-body">
        <div class="item-title">${icon} ${esc(ev.title)}</div>
        ${timeStr ? `<div class="item-meta">⏰ ${esc(timeStr)}</div>` : ''}
      </div>
    </div>`;
}

// ─── Timeline ────────────────────────────────────────────────────────────────

const CAT_ICON = {
  attraction:'🏛', food:'🍜', transport:'🚆',
  accommodation:'🏨', shopping:'🛍', other:'📌',
};

async function renderTimeline() {
  const trip = DB.trip(S.tripId);
  const el   = $('screen-detail');

  const days     = getDays(trip?.startDate, trip?.endDate);
  const events   = DB.events(S.tripId);
  const shopping = DB.shopping(S.tripId);
  const todos    = DB.todos(S.tripId);

  if (!days.length && !events.length && !shopping.length && !todos.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📅</div>
        <p class="empty-title">尚未設定旅行日期</p>
        <p class="empty-desc">請先編輯行程以設定出發和返回日期</p>
        <br>
        <button onclick="openModal('trip', DB.trip(S.tripId))"
          style="background:var(--blue);color:white;border:none;border-radius:10px;padding:10px 24px;font-size:15px;cursor:pointer">
          編輯行程
        </button>
      </div>`;
    return;
  }

  const WD = ['日','一','二','三','四','五','六'];

  // Items added directly in Shopping/Todo tabs (no eventId) with no valid day-of-trip date
  const noDateShop = shopping.filter(s => !s.eventId && !(s.date && days.includes(s.date)));
  const noDateTodo = todos.filter(t => !t.eventId && !(t.assignedDate && days.includes(t.assignedDate)));
  // Events whose date doesn't fall within this trip's date range (e.g. copied in from another trip, or trip has no dates set)
  const noDateEvents = events.filter(e => !(e.date && days.includes(e.date)));

  // Group by eventId once instead of re-filtering the full lists inside eventItem() per event
  const shopByEvent = groupByEventId(shopping);
  const todoByEvent = groupByEventId(todos);

  const noDateEventsHtml = (await Promise.all(noDateEvents.map(ev => eventItem(ev, shopByEvent, todoByEvent)))).join('');
  const noDateHtml = await standaloneListsHtml(noDateShop, noDateTodo);

  const html = (await Promise.all(days.map(async (day, i) => {
    const d        = new Date(day + 'T00:00:00');
    const label    = `第 ${i+1} 天 · ${d.getMonth()+1}/${d.getDate()} (週${WD[d.getDay()]})`;
    const dayEvs   = events
      .filter(e => e.date === day)
      .sort((a,b) => (a.startTime||'').localeCompare(b.startTime||''));

    // Items added directly in Shopping/Todo tabs for this day (no eventId)
    const dayShop        = shopping.filter(s => !s.eventId && s.date === day);
    const dayTodo        = todos.filter(t => !t.eventId && t.assignedDate === day);
    const standaloneHtml = await standaloneListsHtml(dayShop, dayTodo);
    const dayEvsHtml = dayEvs.length
      ? (await Promise.all(dayEvs.map(ev => eventItem(ev, shopByEvent, todoByEvent)))).join('')
      : '';

    return `
      <div class="day-section" data-date="${esc(day)}">
        <div class="day-header">
          <span class="day-label">${esc(label)}</span>
          <button class="btn-add-inline" data-action="add-event" data-date="${esc(day)}">＋ 新增</button>
        </div>
        ${dayEvs.length
          ? dayEvsHtml
          : (standaloneHtml ? '' : `<div class="day-empty">尚無行程，點「新增」加入</div>`)}
        ${standaloneHtml}
      </div>`;
  }))).join('');

  const noDateSection = (noDateEventsHtml || noDateHtml) ? `
    <div class="day-section">
      <div class="day-header"><span class="day-label">整個行程</span></div>
      ${noDateEventsHtml}
      ${noDateHtml}
    </div>` : '';

  el.innerHTML = `<div class="timeline-content">${noDateSection}${html}</div>`;
}

async function standaloneListsHtml(shopItems, todoItems) {
  if (!shopItems.length && !todoItems.length) return '';
  const shopHtml = shopItems.length ? (await Promise.all(shopItems.map(shopItem))).join('') : '';
  const todoHtml = todoItems.length ? (await Promise.all(todoItems.sort(sortTodos).map(todoItem))).join('') : '';
  return `
    ${shopItems.length ? `
      <div class="event-sub-header">🛒 購物（未排入行程項目）</div>
      <div class="item-list">${shopHtml}</div>` : ''}
    ${todoItems.length ? `
      <div class="event-sub-header">✅ 代辦（未排入行程項目）</div>
      <div class="item-list">${todoHtml}</div>` : ''}
  `;
}

function groupByEventId(items) {
  const map = new Map();
  items.forEach(item => {
    if (!item.eventId) return;
    if (!map.has(item.eventId)) map.set(item.eventId, []);
    map.get(item.eventId).push(item);
  });
  return map;
}

async function photoThumbsHtml(photoIds) {
  if (!photoIds || !photoIds.length) return '';
  const shown = photoIds.slice(0, 4);
  const urls  = await Promise.all(shown.map(getPhotoUrl));
  return `
    <div class="item-photos">
      ${urls.map(url => `<img src="${url}" class="item-photo-thumb" data-action="view-photo" data-src="${esc(url)}">`).join('')}
      ${photoIds.length > shown.length ? `<span class="item-photo-more">+${photoIds.length - shown.length}</span>` : ''}
    </div>`;
}

async function eventItem(ev, shopByEvent, todoByEvent) {
  const icon    = CAT_ICON[ev.category] || '📌';
  const timeStr = ev.startTime
    ? (ev.endTime ? `${ev.startTime}–${ev.endTime}` : ev.startTime)
    : '';

  const shopItems = shopByEvent.get(ev.id) || [];
  const todoItems = todoByEvent.get(ev.id) || [];
  const photosHtml = await photoThumbsHtml(ev.photos);

  const shopHtml = shopItems.length ? `
    <div class="inline-list-header">🛒 購物 (${shopItems.length})</div>
    ${shopItems.map(s => `
      <div class="inline-item">
        <button class="check-btn-sm${s.purchased ? ' checked' : ''}"
          data-action="toggle-shopping" data-id="${esc(s.id)}">
          ${s.purchased ? '✓' : ''}
        </button>
        <span class="${s.purchased ? 'strike' : ''}">${esc(s.name)}${s.qty ? ` ×${esc(s.qty)}` : ''}</span>
      </div>`).join('')}` : '';

  const todoHtml = todoItems.length ? `
    <div class="inline-list-header">✅ 代辦 (${todoItems.length})</div>
    ${todoItems.map(t => `
      <div class="inline-item">
        <button class="check-btn-sm${t.completed ? ' checked' : ''}"
          data-action="toggle-todo" data-id="${esc(t.id)}">
          ${t.completed ? '✓' : ''}
        </button>
        <span class="${t.completed ? 'strike' : ''}">${esc(t.title)}</span>
      </div>`).join('')}` : '';

  return `
    <div class="event-item" data-action="edit-event" data-id="${esc(ev.id)}">
      <button class="event-drag-handle" data-action="drag-noop" data-id="${esc(ev.id)}" title="拖曳移動">⠿</button>
      <div class="event-icon">${icon}</div>
      <div class="event-body">
        <div class="event-title">${esc(ev.title)}</div>
        ${timeStr     ? `<div class="event-meta">⏰ ${esc(timeStr)}</div>`    : ''}
        ${ev.location ? `<div class="event-meta">📍 ${esc(ev.location)}</div>`: ''}
        ${ev.notes    ? `<div class="event-notes">${esc(ev.notes)}</div>`     : ''}
        ${photosHtml}
      </div>
      <button class="btn-del" data-action="delete-event" data-id="${esc(ev.id)}">✕</button>
    </div>
    ${(shopHtml || todoHtml) ? `<div class="event-inline-lists">${shopHtml}${todoHtml}</div>` : ''}
    <div class="event-add-btns">
      <button class="btn-add-sub" data-action="add-event-shop"
        data-event-id="${esc(ev.id)}" data-date="${esc(ev.date || '')}">＋ 購物</button>
      <button class="btn-add-sub" data-action="add-event-todo"
        data-event-id="${esc(ev.id)}" data-date="${esc(ev.date || '')}">＋ 代辦</button>
      <button class="btn-add-sub" data-action="move-event" data-id="${esc(ev.id)}">📅 移動</button>
      <button class="btn-add-sub" data-action="copy-event" data-id="${esc(ev.id)}">📋 複製到其他行程</button>
    </div>`;
}

// ─── Shopping ────────────────────────────────────────────────────────────────

async function renderShopping() {
  const items     = DB.shopping(S.tripId);
  const trip      = DB.trip(S.tripId);
  const days      = getDays(trip?.startDate, trip?.endDate);
  const allEvs    = DB.events(S.tripId);
  const evMap     = Object.fromEntries(allEvs.map(e => [e.id, e]));
  const done      = items.filter(i => i.purchased).length;
  const total     = items.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
  const WD        = ['日','一','二','三','四','五','六'];

  let html = `
    <div class="list-header">
      <span>${items.length ? `${done} / ${items.length} 已購買` : '購物清單'}</span>
      ${total ? `<span class="list-summary-price">預估 ¥${total.toLocaleString()}</span>` : ''}
    </div>`;

  if (!items.length) {
    html += `
      <div class="empty-state">
        <div class="empty-icon">🛒</div>
        <p class="empty-title">購物清單是空的</p>
        <p class="empty-desc">在時間軸各行程項目中點「＋ 購物」加入，或點右上角 + 新增</p>
      </div>`;
    $('screen-detail').innerHTML = html;
    return;
  }

  // Resolve each item's effective date
  const byDate = {};
  const noDate = [];
  items.forEach(item => {
    const d = item.eventId ? evMap[item.eventId]?.date : item.date;
    if (d && days.includes(d)) (byDate[d] = byDate[d] || []).push(item);
    else noDate.push(item);
  });

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const dayItems = byDate[day];
    if (!dayItems?.length) continue;
    const d = new Date(day + 'T00:00:00');
    html += `<div class="day-group-header">第${i+1}天 · ${d.getMonth()+1}/${d.getDate()} (週${WD[d.getDay()]})</div>`;

    const dayEvs = allEvs.filter(e => e.date === day)
      .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    const shown = new Set();
    for (const ev of dayEvs) {
      const evItems = dayItems.filter(item => item.eventId === ev.id);
      if (!evItems.length) continue;
      const t = ev.startTime ? `${ev.startTime} ` : '';
      const evItemsHtml = (await Promise.all(evItems.map(shopItem))).join('');
      html += `<div class="event-sub-header">${esc(t + ev.title)}</div>
               <div class="item-list">${evItemsHtml}</div>`;
      evItems.forEach(item => shown.add(item.id));
    }
    const orphans = dayItems.filter(item => !shown.has(item.id));
    if (orphans.length) {
      const orphansHtml = (await Promise.all(orphans.map(shopItem))).join('');
      html += `<div class="event-sub-header">其他</div>
               <div class="item-list">${orphansHtml}</div>`;
    }
  }

  if (noDate.length) {
    const noDateHtml = (await Promise.all(noDate.map(shopItem))).join('');
    html += `<div class="day-group-header">整個行程</div>
             <div class="item-list">${noDateHtml}</div>`;
  }

  $('screen-detail').innerHTML = html;
}

async function shopItem(item) {
  const meta = [
    item.qty      ? `數量：${esc(item.qty)}`   : '',
    item.price    ? `¥${esc(item.price)}`      : '',
    item.category ? esc(item.category)         : '',
  ].filter(Boolean).join(' · ');
  const photosHtml = await photoThumbsHtml(item.photos);

  return `
    <div class="list-item${item.purchased ? ' item-done' : ''}" data-action="edit-shopping" data-id="${esc(item.id)}">
      <button class="check-btn${item.purchased ? ' checked' : ''}"
        data-action="toggle-shopping" data-id="${esc(item.id)}">
        ${item.purchased ? '✓' : ''}
      </button>
      <div class="item-body">
        <div class="item-title">${esc(item.name)}</div>
        ${meta  ? `<div class="item-meta">${meta}</div>`               : ''}
        ${item.notes ? `<div class="item-notes">${esc(item.notes)}</div>` : ''}
        ${photosHtml}
      </div>
      <button class="btn-copy" data-action="copy-shopping" data-id="${esc(item.id)}" title="複製到其他行程">📋</button>
      <button class="btn-del" data-action="delete-shopping" data-id="${esc(item.id)}">✕</button>
    </div>`;
}

// ─── Todo ─────────────────────────────────────────────────────────────────────

const PRIO = {
  high:   { emoji: '🔴', label: '高優先', color: '#FF3B30' },
  medium: { emoji: '🟡', label: '中優先', color: '#FF9500' },
  low:    { emoji: '🟢', label: '低優先', color: '#34C759' },
};
const PRIO_ORDER = { high: 0, medium: 1, low: 2 };

function sortTodos(a, b) {
  if (a.completed !== b.completed) return a.completed ? 1 : -1;
  return (PRIO_ORDER[a.priority] ?? 1) - (PRIO_ORDER[b.priority] ?? 1);
}

async function renderTodo() {
  const todos     = DB.todos(S.tripId);
  const trip      = DB.trip(S.tripId);
  const days      = getDays(trip?.startDate, trip?.endDate);
  const allEvs    = DB.events(S.tripId);
  const evMap     = Object.fromEntries(allEvs.map(e => [e.id, e]));
  const done      = todos.filter(t => t.completed).length;
  const WD        = ['日','一','二','三','四','五','六'];

  let html = `
    <div class="list-header">
      <span>${todos.length ? `${done} / ${todos.length} 已完成` : '代辦事項'}</span>
    </div>`;

  if (!todos.length) {
    html += `
      <div class="empty-state">
        <div class="empty-icon">✅</div>
        <p class="empty-title">代辦清單是空的</p>
        <p class="empty-desc">在時間軸各行程項目中點「＋ 代辦」加入，或點右上角 + 新增</p>
      </div>`;
    $('screen-detail').innerHTML = html;
    return;
  }

  // Resolve each todo's effective date (via eventId or assignedDate)
  const byDate = {};
  const noDate = [];
  todos.forEach(t => {
    const d = t.eventId ? evMap[t.eventId]?.date : t.assignedDate;
    if (d && days.includes(d)) (byDate[d] = byDate[d] || []).push(t);
    else noDate.push(t);
  });

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const dayTodos = byDate[day];
    if (!dayTodos?.length) continue;
    const d = new Date(day + 'T00:00:00');
    html += `<div class="day-group-header">第${i+1}天 · ${d.getMonth()+1}/${d.getDate()} (週${WD[d.getDay()]})</div>`;

    const dayEvs = allEvs.filter(e => e.date === day)
      .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    const shown = new Set();
    for (const ev of dayEvs) {
      const evTodos = dayTodos.filter(t => t.eventId === ev.id);
      if (!evTodos.length) continue;
      const ti = ev.startTime ? `${ev.startTime} ` : '';
      const evTodosHtml = (await Promise.all(evTodos.sort(sortTodos).map(todoItem))).join('');
      html += `<div class="event-sub-header">${esc(ti + ev.title)}</div>
               <div class="item-list">${evTodosHtml}</div>`;
      evTodos.forEach(t => shown.add(t.id));
    }
    const orphans = dayTodos.filter(t => !shown.has(t.id)).sort(sortTodos);
    if (orphans.length) {
      const orphansHtml = (await Promise.all(orphans.map(todoItem))).join('');
      html += `<div class="event-sub-header">其他</div>
               <div class="item-list">${orphansHtml}</div>`;
    }
  }

  if (noDate.length) {
    const noDateHtml = (await Promise.all(noDate.sort(sortTodos).map(todoItem))).join('');
    html += `<div class="day-group-header">整個行程</div>
             <div class="item-list">${noDateHtml}</div>`;
  }

  $('screen-detail').innerHTML = html;
}

async function todoItem(todo) {
  const p    = PRIO[todo.priority] || PRIO.medium;
  const meta = [
    `<span class="priority-emoji">${p.emoji}</span>${p.label}`,
    todo.dueDate ? `截止 ${formatDate(todo.dueDate)}` : '',
  ].filter(Boolean).join(' · ');
  const photosHtml = await photoThumbsHtml(todo.photos);

  return `
    <div class="list-item${todo.completed ? ' item-done' : ''}" data-action="edit-todo" data-id="${esc(todo.id)}">
      <button class="check-btn${todo.completed ? ' checked' : ''}"
        data-action="toggle-todo" data-id="${esc(todo.id)}">
        ${todo.completed ? '✓' : ''}
      </button>
      <div class="item-body">
        <div class="item-title">${esc(todo.title)}</div>
        <div class="item-meta">${meta}</div>
        ${todo.notes ? `<div class="item-notes">${esc(todo.notes)}</div>` : ''}
        ${photosHtml}
      </div>
      <button class="btn-copy" data-action="copy-todo" data-id="${esc(todo.id)}" title="複製到其他行程">📋</button>
      <button class="btn-del" data-action="delete-todo" data-id="${esc(todo.id)}">✕</button>
    </div>`;
}

// ─── Locations ───────────────────────────────────────────────────────────────

const LOC_ICON  = { attraction:'🏛', food:'🍽', accommodation:'🏨', shopping:'🛍', transport:'🚉', other:'📍' };
const LOC_LABEL = { attraction:'景點', food:'餐廳', accommodation:'住宿', shopping:'購物', transport:'交通', other:'其他' };

function renderLocations() {
  const locs = DB.locations(S.tripId);

  if (!locs.length) {
    $('screen-detail').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔖</div>
        <p class="empty-title">收藏夾是空的</p>
        <p class="empty-desc">把想去的地方存在這裡，等行程確定後再點「加入行程」把它排進時間軸</p>
      </div>`;
    return;
  }

  $('screen-detail').innerHTML = `<div class="locations-list">${locs.map(locCard).join('')}</div>`;
}

function locCard(loc) {
  const icon   = LOC_ICON[loc.category]  || '📍';
  const label  = LOC_LABEL[loc.category] || '';
  const qName  = encodeURIComponent(loc.name);
  const qAddr  = loc.address ? encodeURIComponent(loc.address) : '';
  const mapsUrl = qAddr
    ? `https://maps.apple.com/?q=${qName}&address=${qAddr}`
    : `https://maps.apple.com/?q=${qName}`;

  return `
    <div class="location-card" data-action="edit-location" data-id="${esc(loc.id)}">
      <div class="location-icon">${icon}</div>
      <div class="location-body">
        <div class="location-name">${esc(loc.name)}</div>
        ${label       ? `<div class="location-cat">${label}</div>`                  : ''}
        ${loc.address ? `<div class="location-address">📍 ${esc(loc.address)}</div>`: ''}
        ${loc.notes   ? `<div class="location-notes">${esc(loc.notes)}</div>`       : ''}
        <div class="loc-actions">
          <a href="${mapsUrl}" class="maps-link" target="_blank" rel="noopener">在地圖中開啟 →</a>
          <button class="btn-add-to-trip" data-action="add-loc-to-timeline"
            data-id="${esc(loc.id)}" data-name="${esc(loc.name)}" data-addr="${esc(loc.address||'')}">
            ＋ 加入行程
          </button>
        </div>
      </div>
      <button class="btn-del" data-action="delete-location" data-id="${esc(loc.id)}">✕</button>
    </div>`;
}

// ─── Import / Export ─────────────────────────────────────────────────────────

function safeFileName(name) {
  return (name || '行程').replace(/[\\/:*?"<>|]/g, '').trim() || '行程';
}

function showProcessing(text) {
  $('processing-text').textContent = text || '處理中，請稍候...';
  $('processing-overlay').style.display = 'flex';
}

function hideProcessing() {
  $('processing-overlay').style.display = 'none';
}

// Photos within one item, and items within one list, are all independent —
// process them concurrently instead of one-at-a-time. With real phone photos
// (much bigger than a test image) a sequential loop could take long enough,
// with zero visual feedback, to look like the app had frozen.
async function inlinePhotosForExport(items) {
  return Promise.all(items.map(async item => {
    if (!item.photos || !item.photos.length) return item;
    const dataUrls = (await Promise.all(item.photos.map(async id => {
      const blob = await loadPhotoBlob(id);
      return blob ? blobToDataUrl(blob) : null;
    }))).filter(Boolean);
    return { ...item, photos: dataUrls };
  }));
}

async function exportTrip(tripId) {
  const trip = DB.trip(tripId);
  if (!trip) return;

  showProcessing('準備匯出檔案，請稍候...');
  try {
    const payload = {
      app:       'osaka-trip-planner',
      version:   2,
      trip,
      events:    await inlinePhotosForExport(DB.events(tripId)),
      shopping:  await inlinePhotosForExport(DB.shopping(tripId)),
      todos:     await inlinePhotosForExport(DB.todos(tripId)),
      locations: DB.locations(tripId),
    };

    const filename = `${safeFileName(trip.name)}.json`;
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const file = new File([blob], filename, { type: 'application/json' });

    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: trip.name });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } finally {
    hideProcessing();
  }
}

async function importPhotosFromDataUrls(photos) {
  if (!photos || !photos.length) return [];
  const ids = await Promise.all(photos.map(async src => {
    if (typeof src !== 'string' || !src.startsWith('data:')) return null;
    try {
      const blob = await (await fetch(src)).blob();
      const id = genId();
      await savePhotoBlob(id, blob);
      return id;
    } catch {
      return null; // skip photo that fails to import
    }
  }));
  return ids.filter(Boolean);
}

async function importTripFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert('這不是有效的行程檔案'); return;
  }
  if (!data?.trip?.name) { alert('這不是有效的行程檔案'); return; }

  showProcessing('匯入中，請稍候...');
  try {
    const newTripId = genId();
    DB.saveTrip({ ...data.trip, id: newTripId });

    // Generate every event's new id up front (synchronous) so the map is
    // complete before shopping/todos need it, then process each list's
    // items (photo import + save) concurrently rather than one at a time.
    const eventIdMap = new Map();
    (data.events || []).forEach(ev => eventIdMap.set(ev.id, genId()));

    await Promise.all((data.events || []).map(async ev => {
      const photos = await importPhotosFromDataUrls(ev.photos);
      DB.saveEvent({ ...ev, id: eventIdMap.get(ev.id), tripId: newTripId, photos });
    }));

    await Promise.all((data.shopping || []).map(async item => {
      const photos = await importPhotosFromDataUrls(item.photos);
      DB.saveShop({
        ...item,
        id: genId(),
        tripId: newTripId,
        eventId: item.eventId ? (eventIdMap.get(item.eventId) || null) : null,
        photos,
      });
    }));

    await Promise.all((data.todos || []).map(async item => {
      const photos = await importPhotosFromDataUrls(item.photos);
      DB.saveTodo({
        ...item,
        id: genId(),
        tripId: newTripId,
        eventId: item.eventId ? (eventIdMap.get(item.eventId) || null) : null,
        photos,
      });
    }));

    (data.locations || []).forEach(loc => {
      DB.saveLoc({ ...loc, id: genId(), tripId: newTripId });
    });

    render();
    openTrip(newTripId);
  } finally {
    hideProcessing();
  }
}

// ─── CSV Import ──────────────────────────────────────────────────────────────
// Expected columns (header row, order doesn't matter):
//   類型(type), 標題/名稱(title), 日期(date), 開始時間(startTime), 結束時間(endTime),
//   分類(category), 地點/地址(location), 數量(qty), 金額(price),
//   截止日期(dueDate), 優先度(priority), 備註(notes)
// 類型 accepts: event/行程, shopping/購物, todo/代辦, location/地點
// 分類(event/location) accepts: 景點/餐廳/交通/住宿/購物/其他 or the raw English code
// 優先度 accepts: 高/中/低 or high/medium/low
// 日期 accepts YYYY-MM-DD, YYYY/MM/DD, or an Excel date serial number

const CSV_HEADER_ALIASES = {
  type:      ['類型', 'type'],
  title:     ['標題', '名稱', '品項名稱', '事項名稱', '地點名稱', 'title', 'name'],
  date:      ['日期', 'date'],
  startTime: ['開始時間', 'starttime', 'start'],
  endTime:   ['結束時間', 'endtime', 'end'],
  category:  ['分類', 'category'],
  location:  ['地點', '地址', 'location', 'address'],
  qty:       ['數量', 'qty', 'quantity'],
  price:     ['金額', '價格', 'price'],
  dueDate:   ['截止日期', 'duedate'],
  priority:  ['優先度', '優先級', 'priority'],
  notes:     ['備註', 'notes', 'note'],
};

const CSV_CATEGORY_MAP = {
  '景點': 'attraction', '餐廳': 'food', '交通': 'transport',
  '住宿': 'accommodation', '購物': 'shopping', '其他': 'other',
  attraction: 'attraction', food: 'food', transport: 'transport',
  accommodation: 'accommodation', shopping: 'shopping', other: 'other',
};

const CSV_PRIORITY_MAP = {
  '高': 'high', '中': 'medium', '低': 'low',
  high: 'high', medium: 'medium', low: 'low',
};

const CSV_TYPE_MAP = {
  event: 'event', '行程': 'event', '時間軸': 'event',
  shopping: 'shopping', '購物': 'shopping',
  todo: 'todo', '代辦': 'todo', '待辦': 'todo',
  location: 'location', '地點': 'location', '收藏': 'location',
};

function resolveCsvHeaderKey(rawHeader) {
  const h = rawHeader.trim();
  const hLower = h.toLowerCase();
  for (const [key, aliases] of Object.entries(CSV_HEADER_ALIASES)) {
    if (aliases.some(a => a === h || a === hLower)) return key;
  }
  return null;
}

function normalizeCsvType(v)     { return CSV_TYPE_MAP[(v || '').trim()] ?? CSV_TYPE_MAP[(v || '').trim().toLowerCase()] ?? null; }
function normalizeCsvCategory(v) { return CSV_CATEGORY_MAP[(v || '').trim()] ?? CSV_CATEGORY_MAP[(v || '').trim().toLowerCase()] ?? ''; }
function normalizeCsvPriority(v) { return CSV_PRIORITY_MAP[(v || '').trim()] ?? CSV_PRIORITY_MAP[(v || '').trim().toLowerCase()] ?? ''; }

function excelSerialToDateStr(serial) {
  const utcMs = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function normalizeCsvDate(v) {
  const s = (v || '').trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 60000) return excelSerialToDateStr(n);
  }
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;
  return s;
}

function normalizeCsvTime(v) {
  const s = (v || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i);
  if (!m) return s;
  let h = Number(m[1]);
  if (m[3]) {
    const ap = m[3].toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
  }
  return `${pad2(h)}:${m[2]}`;
}

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
}

async function importCsvFile(file) {
  const text = await file.text();
  const rows = parseCSV(text);
  if (rows.length < 2) { alert('CSV 檔案是空的，或只有標題列'); return; }

  const keyMap = rows[0].map(resolveCsvHeaderKey);
  if (!keyMap.includes('type') || !keyMap.includes('title')) {
    alert('CSV 缺少必要欄位：請確認有「類型」與「標題/名稱」欄位'); return;
  }

  let ok = 0;
  const errors = [];

  showProcessing('匯入中，請稍候...');
  try {
    rows.slice(1).forEach((r, i) => {
      const lineNo = i + 2;
      if (r.every(c => c.trim() === '')) return;

      const rec = {};
      keyMap.forEach((key, colIdx) => { if (key) rec[key] = (r[colIdx] ?? '').trim(); });

      const type = normalizeCsvType(rec.type);
      if (!type)      { errors.push(`第 ${lineNo} 列：無法辨識的類型「${rec.type || ''}」`); return; }
      if (!rec.title) { errors.push(`第 ${lineNo} 列：缺少標題/名稱`); return; }

      try {
        switch (type) {
          case 'event':
            DB.saveEvent({
              id: genId(), tripId: S.tripId, title: rec.title,
              date: normalizeCsvDate(rec.date),
              startTime: normalizeCsvTime(rec.startTime),
              endTime: normalizeCsvTime(rec.endTime),
              category: normalizeCsvCategory(rec.category) || 'other',
              location: rec.location || '', notes: rec.notes || '', photos: [],
            });
            break;
          case 'shopping':
            DB.saveShop({
              id: genId(), tripId: S.tripId, name: rec.title,
              qty: rec.qty || '', price: rec.price || '', category: rec.category || '',
              date: normalizeCsvDate(rec.date), eventId: null,
              notes: rec.notes || '', photos: [], purchased: false,
            });
            break;
          case 'todo':
            DB.saveTodo({
              id: genId(), tripId: S.tripId, title: rec.title,
              dueDate: normalizeCsvDate(rec.dueDate),
              priority: normalizeCsvPriority(rec.priority) || 'medium',
              assignedDate: normalizeCsvDate(rec.date), eventId: null,
              notes: rec.notes || '', photos: [], completed: false,
            });
            break;
          case 'location':
            DB.saveLoc({
              id: genId(), tripId: S.tripId, name: rec.title,
              address: rec.location || '',
              category: normalizeCsvCategory(rec.category) || 'other',
              notes: rec.notes || '',
            });
            break;
        }
        ok++;
      } catch (err) {
        errors.push(`第 ${lineNo} 列：儲存失敗（${err?.message || err}）`);
      }
    });

    await renderDetail();
  } finally {
    hideProcessing();
  }

  let msg = `匯入完成：成功 ${ok} 筆`;
  if (errors.length) {
    msg += `，略過 ${errors.length} 筆\n\n` + errors.slice(0, 10).join('\n');
    if (errors.length > 10) msg += `\n...其餘 ${errors.length - 10} 筆省略`;
  }
  alert(msg);
}

// ─── Modal: Open ─────────────────────────────────────────────────────────────

function openModal(type, data) {
  S.modal  = type;
  S.editId = data?.id || null;

  $('modal-overlay').style.display = '';
  document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');

  switch (type) {
    case 'trip':     fillTripForm(data);     $('modal-trip').style.display     = ''; break;
    case 'event':    fillEventForm(data);    $('modal-event').style.display    = ''; break;
    case 'shopping': fillShoppingForm(data); $('modal-shopping').style.display = ''; break;
    case 'todo':     fillTodoForm(data);     $('modal-todo').style.display     = ''; break;
    case 'location': fillLocationForm(data); $('modal-location').style.display = ''; break;
    case 'move-event': fillMoveEventForm(data); $('modal-move').style.display  = ''; break;
  }
}

function fillTripForm(t) {
  $('modal-trip-title').textContent = t ? '編輯行程' : '新增行程';
  $('trip-name').value        = t?.name        || '';
  $('trip-destination').value = t?.destination || '';
  $('trip-start').value       = t?.startDate   || '';
  $('trip-end').value         = t?.endDate     || '';
  $('trip-notes').value       = t?.notes       || '';
}

// ─── Photos ────────────────────────────────────────────────────────────────

async function initPhotos(kind, photos) {
  S.editPhotos = photos ? [...photos] : [];
  await renderPhotoStrip(kind);
}

async function renderPhotoStrip(kind) {
  const strip = $(`${kind}-photo-strip`);
  if (!strip) return;
  const urls = await Promise.all(S.editPhotos.map(getPhotoUrl));
  strip.innerHTML = S.editPhotos.map((_id, i) => `
    <div class="photo-thumb">
      <img src="${urls[i]}" data-action="view-photo" data-src="${esc(urls[i])}">
      <button type="button" class="photo-remove" data-action="remove-photo" data-index="${i}">✕</button>
    </div>`).join('') +
    (S.editPhotos.length < MAX_PHOTOS_PER_ITEM
      ? `<button type="button" class="photo-add-tile" data-action="pick-photo" data-kind="${kind}">＋</button>`
      : '');
}

function readAndCompressImage(file, maxDim = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('圖片讀取失敗'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width  = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob(blob => {
          if (blob) resolve(blob); else reject(new Error('圖片壓縮失敗'));
        }, 'image/jpeg', quality);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handlePhotoFiles(kind, files) {
  const room = MAX_PHOTOS_PER_ITEM - S.editPhotos.length;
  if (room <= 0) { alert(`最多只能加 ${MAX_PHOTOS_PER_ITEM} 張照片`); return; }

  const toProcess = files.filter(f => f.type.startsWith('image/')).slice(0, room);
  for (const file of toProcess) {
    try {
      const blob = await readAndCompressImage(file);
      const id = genId();
      await savePhotoBlob(id, blob);
      S.editPhotos.push(id);
    } catch {
      alert(`「${file.name}」讀取失敗，已略過`);
    }
  }
  await renderPhotoStrip(kind);
}

function fillEventForm(ev) {
  $('modal-event-title').textContent    = ev?.id ? '編輯行程項目' : '新增行程項目';
  $('event-title-input').value          = ev?.title     || '';
  $('event-date').value                   = ev?.date     || S.pendingDate || '';
  $('event-location-input').value       = ev?.location  || '';
  $('event-category').value             = ev?.category  || 'attraction';
  $('event-notes').value                = ev?.notes     || '';
  setupTimeWheels(ev?.startTime || '', ev?.endTime || '');
  initPhotos('event', ev?.photos);
  S.pendingDate = null;
}

// ─── Time Wheel Picker ────────────────────────────────────────────────────────

const WHEEL_ITEM_H  = 36;
const AMPM_ITEMS     = [{ value: 'AM', label: '上午' }, { value: 'PM', label: '下午' }];
const HOUR12_ITEMS   = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));
const MIN_ITEMS      = [{ value: '00', label: '00' }, { value: '30', label: '30' }];
const DUR_HOUR_ITEMS = Array.from({ length: 13 }, (_, i) => ({ value: String(i), label: String(i) }));

const wheelState = { start: { ampm: 'AM', hour: '9', min: '00' }, dur: { hour: '1', min: '00' } };

function freshEl(id) {
  const old = $(id);
  const clone = old.cloneNode(false);
  old.replaceWith(clone);
  return clone;
}

function markWheelSelected(el, idx) {
  el.querySelectorAll('.wheel-item').forEach((it, i) => it.classList.toggle('selected', i === idx));
}

function buildWheelCol(id, items, selectedValue, onSettle) {
  const el = freshEl(id);
  el.innerHTML = '<div class="wheel-pad"></div>' +
    items.map(it => `<div class="wheel-item" data-value="${esc(it.value)}">${esc(it.label)}</div>`).join('') +
    '<div class="wheel-pad"></div>';

  const idx = Math.max(0, items.findIndex(it => it.value === selectedValue));
  el.scrollTop = idx * WHEEL_ITEM_H;
  markWheelSelected(el, idx);

  let settleTimer = null;
  el.addEventListener('scroll', () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const i = Math.min(items.length - 1, Math.max(0, Math.round(el.scrollTop / WHEEL_ITEM_H)));
      markWheelSelected(el, i);
      onSettle(items[i].value);
    }, 130);
  });

  // Mouse drag-to-scroll (touch already scrolls natively; only handle mouse/pen)
  let dragging = false, dragMoved = false, startY = 0, startScroll = 0;
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') return;
    dragging = true; dragMoved = false;
    startY = e.clientY; startScroll = el.scrollTop;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 3) dragMoved = true;
    el.scrollTop = startScroll - dy;
  });
  el.addEventListener('pointerup',     () => { dragging = false; });
  el.addEventListener('pointercancel', () => { dragging = false; });

  el.addEventListener('click', e => {
    if (dragMoved) { dragMoved = false; return; }
    const item = e.target.closest('.wheel-item');
    if (!item) return;
    const i = [...el.children].indexOf(item) - 1;
    el.scrollTo({ top: i * WHEEL_ITEM_H, behavior: 'smooth' });
  });
}

function setupTimeWheels(startTime, endTime) {
  const has = !!startTime;
  $('event-has-time').checked = has;
  $('event-time-fields').style.display = has ? '' : 'none';

  const st = to12h(startTime || '09:00');
  wheelState.start = { ...st };
  buildWheelCol('wheel-start-ampm', AMPM_ITEMS,   st.ampm, v => { wheelState.start.ampm = v; updateComputedEndTime(); });
  buildWheelCol('wheel-start-hour', HOUR12_ITEMS, st.hour, v => { wheelState.start.hour = v; updateComputedEndTime(); });
  buildWheelCol('wheel-start-min',  MIN_ITEMS,    st.min,  v => { wheelState.start.min  = v; updateComputedEndTime(); });

  let durTotal = 60;
  if (startTime && endTime) {
    durTotal = (toMinutes(endTime) - toMinutes(startTime) + 24 * 60) % (24 * 60);
  }
  wheelState.dur = {
    hour: String(Math.min(Math.floor(durTotal / 60), 12)),
    min:  (durTotal % 60) >= 30 ? '30' : '00',
  };
  buildWheelCol('wheel-dur-hour', DUR_HOUR_ITEMS, wheelState.dur.hour, v => { wheelState.dur.hour = v; updateComputedEndTime(); });
  buildWheelCol('wheel-dur-min',  MIN_ITEMS,      wheelState.dur.min,  v => { wheelState.dur.min  = v; updateComputedEndTime(); });

  updateComputedEndTime();
}

function updateComputedEndTime() {
  if (!$('event-has-time').checked) { $('event-start-time').value = ''; $('event-end-time').value = ''; return; }

  const start24 = from12h(wheelState.start.ampm, wheelState.start.hour, wheelState.start.min);
  const durMin  = Number(wheelState.dur.hour) * 60 + Number(wheelState.dur.min);
  let endMin     = toMinutes(start24) + durMin;
  let clamped    = false;
  if (endMin >= 24 * 60) { endMin = 23 * 60 + 30; clamped = true; }
  const end24 = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;

  $('event-start-time').value = start24;
  $('event-end-time').value   = end24;
  $('duration-end-preview').textContent = clamped
    ? `結束於 ${end24}（已達當日最晚時間）`
    : `結束於 ${end24}`;
}

function fillShoppingForm(item) {
  $('modal-shopping-title').textContent = item ? '編輯購物項目' : '新增購物項目';
  $('shopping-name').value     = item?.name     || '';
  $('shopping-qty').value      = item?.qty      || '';
  $('shopping-price').value    = item?.price    || '';
  $('shopping-category').value = item?.category || '';
  $('shopping-notes').value    = item?.notes    || '';
  $('shopping-date').innerHTML = buildDayOptions(S.tripId, item?.date || S.pendingDate || '');
  initPhotos('shopping', item?.photos);
}

function fillTodoForm(todo) {
  $('modal-todo-title').textContent = todo ? '編輯代辦事項' : '新增代辦事項';
  $('todo-title-input').value = todo?.title        || '';
  $('todo-due').value         = todo?.dueDate      || '';
  $('todo-priority').value    = todo?.priority     || 'medium';
  $('todo-notes').value       = todo?.notes        || '';
  $('todo-assigned-date').innerHTML = buildDayOptions(S.tripId, todo?.assignedDate || S.pendingDate || '');
  initPhotos('todo', todo?.photos);
}

function fillMoveEventForm(ev) {
  $('move-event-date').innerHTML = buildDayOptions(S.tripId, ev?.date || '');
}

// ─── Copy to another trip ────────────────────────────────────────────────────

function buildTripOptions(excludeTripId) {
  const trips = DB.trips().filter(t => t.id !== excludeTripId);
  if (!trips.length) return '<option value="">沒有其他行程可選</option>';
  return trips.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
}

function openCopyModal(itemType, itemId) {
  const trips = DB.trips().filter(t => t.id !== S.tripId);
  if (!trips.length) { alert('目前沒有其他行程可以複製過去，請先建立另一個行程'); return; }

  S.copyType   = itemType;
  S.copyItemId = itemId;
  $('copy-target-trip').innerHTML = buildTripOptions(S.tripId);

  $('modal-overlay').style.display = '';
  document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
  $('modal-copy').style.display = '';
  S.modal = 'copy';
}

async function saveCopyForm() {
  const targetId = $('copy-target-trip').value;
  if (!targetId) { closeModal(); return; }

  let item;
  if      (S.copyType === 'event')    item = DB.event(S.copyItemId);
  else if (S.copyType === 'shopping') item = DB.shopItem(S.copyItemId);
  else if (S.copyType === 'todo')     item = DB.todo(S.copyItemId);
  if (!item) { closeModal(); return; }

  // Duplicate the underlying photo blobs (not just the ids) so the copy is
  // truly independent — otherwise deleting a photo on one side, or deleting
  // the original item, would silently break the other side's photos too.
  const newPhotoIds = await duplicatePhotoBlobs(item.photos);

  const copy = { ...item, id: genId(), tripId: targetId, eventId: null, photos: newPhotoIds };
  if      (S.copyType === 'event')    DB.saveEvent(copy);
  else if (S.copyType === 'shopping') DB.saveShop(copy);
  else if (S.copyType === 'todo')     DB.saveTodo(copy);

  const targetName = DB.trip(targetId)?.name || '';
  closeModal();
  alert(`已複製到「${targetName}」`);
}

function fillLocationForm(loc) {
  $('modal-location-title').textContent = loc ? '編輯地點' : '新增地點';
  $('location-name').value     = loc?.name     || '';
  $('location-address').value  = loc?.address  || '';
  $('location-category').value = loc?.category || 'attraction';
  $('location-notes').value    = loc?.notes    || '';
}

// ─── Modal: Close ────────────────────────────────────────────────────────────

function closeModal() {
  $('modal-overlay').style.display = 'none';
  document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
  S.modal = null; S.editId = null; S.confirmCb = null;
  S.pendingDate = null; S.pendingEventId = null; S.editPhotos = [];
  S.copyType = null; S.copyItemId = null;
}


// ─── Modal: Save ─────────────────────────────────────────────────────────────

function saveModal() {
  switch (S.modal) {
    case 'trip':     saveTripForm();     break;
    case 'event':    saveEventForm();    break;
    case 'shopping': saveShoppingForm(); break;
    case 'todo':     saveTodoForm();     break;
    case 'location': saveLocationForm(); break;
    case 'move-event': saveMoveEventForm(); break;
    case 'copy': saveCopyForm(); break;
  }
}

function saveTripForm() {
  const name = $('trip-name').value.trim();
  if (!name) { alert('請輸入行程名稱'); return; }
  const isNew = !S.editId;
  const id    = S.editId || genId();
  DB.saveTrip({
    id,
    name,
    destination: $('trip-destination').value.trim(),
    startDate:   $('trip-start').value,
    endDate:     $('trip-end').value,
    notes:       $('trip-notes').value.trim(),
  });
  closeModal();
  if (isNew) openTrip(id);
  else render();
}

function saveEventForm() {
  const title     = $('event-title-input').value.trim();
  if (!title) { alert('請輸入行程標題'); return; }

  const date      = $('event-date').value;
  const startTime = $('event-start-time').value;
  const endTime   = $('event-end-time').value;

  if (startTime && endTime && startTime >= endTime) {
    alert('結束時間必須晚於開始時間'); return;
  }

  if (!confirmNoTimeConflict(S.editId, date, startTime, endTime)) return;

  const existing = S.editId ? DB.event(S.editId) : null;
  const removedPhotoIds = (existing?.photos || []).filter(id => !S.editPhotos.includes(id));

  DB.saveEvent({
    id:        S.editId || genId(),
    tripId:    S.tripId,
    title,
    date,
    startTime,
    endTime,
    location:  $('event-location-input').value.trim(),
    category:  $('event-category').value,
    notes:     $('event-notes').value.trim(),
    photos:    [...S.editPhotos],
  });
  if (removedPhotoIds.length) deletePhotoBlobs(removedPhotoIds).catch(() => {});
  closeModal();
  renderDetail();
}

function confirmNoTimeConflict(excludeId, date, startTime, endTime, extraExcludeIds = []) {
  if (!date || !startTime || !endTime) return true;
  const excludeSet = new Set([excludeId, ...extraExcludeIds]);
  const conflicts = DB.events(S.tripId).filter(ev => {
    if (excludeSet.has(ev.id) || ev.date !== date) return false;
    if (!ev.startTime || !ev.endTime) return false;
    return startTime < ev.endTime && ev.startTime < endTime;
  });
  if (!conflicts.length) return true;
  const names = conflicts.map(e => `「${e.title}」`).join('、');
  return confirm(`此行程時間與 ${names} 重疊，確定要繼續嗎？`);
}

function saveMoveEventForm() {
  const ev = DB.event(S.editId);
  if (!ev) { closeModal(); return; }

  const newDate = $('move-event-date').value;
  if (newDate === ev.date) { closeModal(); return; }

  if (!confirmNoTimeConflict(ev.id, newDate, ev.startTime, ev.endTime)) return;

  DB.saveEvent({ ...ev, date: newDate });
  closeModal();
  renderDetail();
}

function saveShoppingForm() {
  const name = $('shopping-name').value.trim();
  if (!name) { alert('請輸入品項名稱'); return; }
  const existing = S.editId ? DB.shopItem(S.editId) : null;
  const removedPhotoIds = (existing?.photos || []).filter(id => !S.editPhotos.includes(id));
  DB.saveShop({
    id:        S.editId || genId(),
    tripId:    S.tripId,
    name,
    qty:       $('shopping-qty').value.trim(),
    price:     $('shopping-price').value,
    category:  $('shopping-category').value.trim(),
    notes:     $('shopping-notes').value.trim(),
    purchased: existing?.purchased || false,
    date:      $('shopping-date').value || S.pendingDate || '',
    eventId:   S.pendingEventId || existing?.eventId || null,
    photos:    [...S.editPhotos],
  });
  if (removedPhotoIds.length) deletePhotoBlobs(removedPhotoIds).catch(() => {});
  closeModal();
  renderDetail();
}

function saveTodoForm() {
  const title = $('todo-title-input').value.trim();
  if (!title) { alert('請輸入事項名稱'); return; }
  const existing = S.editId ? DB.todo(S.editId) : null;
  const removedPhotoIds = (existing?.photos || []).filter(id => !S.editPhotos.includes(id));
  DB.saveTodo({
    id:        S.editId || genId(),
    tripId:    S.tripId,
    title,
    dueDate:   $('todo-due').value,
    priority:  $('todo-priority').value,
    notes:     $('todo-notes').value.trim(),
    completed:    existing?.completed || false,
    assignedDate: $('todo-assigned-date').value || S.pendingDate || '',
    eventId:      S.pendingEventId || existing?.eventId || null,
    photos:       [...S.editPhotos],
  });
  if (removedPhotoIds.length) deletePhotoBlobs(removedPhotoIds).catch(() => {});
  closeModal();
  renderDetail();
}

function saveLocationForm() {
  const name = $('location-name').value.trim();
  if (!name) { alert('請輸入地點名稱'); return; }
  DB.saveLoc({
    id:       S.editId || genId(),
    tripId:   S.tripId,
    name,
    address:  $('location-address').value.trim(),
    category: $('location-category').value,
    notes:    $('location-notes').value.trim(),
  });
  closeModal();
  renderDetail();
}

// ─── Confirm Dialog ──────────────────────────────────────────────────────────

function showConfirm(msg, cb) {
  S.confirmCb = cb;
  $('confirm-msg').textContent = msg;
  $('modal-overlay').style.display = '';
  document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
  $('modal-confirm').style.display = '';
  S.modal = 'confirm';
}

// ─── Header Action ───────────────────────────────────────────────────────────

function headerAdd() {
  if (S.view === 'trips') { openModal('trip'); return; }
  const map = { overview:'event', timeline:'event', shopping:'shopping', todo:'todo' };
  openModal(map[S.tab]);
}

// ─── Event Delegation ────────────────────────────────────────────────────────

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  e.stopPropagation();

  const action = el.dataset.action;
  const id     = el.dataset.id;
  const date   = el.dataset.date;

  switch (action) {

    // ── Trips ──
    case 'open-trip':
      openTrip(id); break;

    // ── Overview: jump to a day in the Timeline tab ──
    case 'goto-day': {
      S.tab = 'timeline';
      await renderDetail();
      syncTabBar();
      document.querySelector(`.day-section[data-date="${CSS.escape(date)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }

    case 'delete-trip':
      showConfirm('確定要刪除這個行程？\n（所有相關資料都會一起刪除）', () => {
        DB.deleteTrip(id); render();
      }); break;

    case 'export-trip':
      exportTrip(id); break;

    // ── Events ──
    case 'add-event':
      S.pendingDate = date; openModal('event'); break;

    case 'edit-event':
      openModal('event', DB.event(id)); break;

    case 'move-event':
      openModal('move-event', DB.event(id)); break;

    case 'copy-event':
      openCopyModal('event', id); break;

    case 'delete-event':
      showConfirm('確定要刪除這個行程項目？', () => {
        DB.deleteEvent(id); renderDetail();
      }); break;

    // ── Add from event inline buttons ──
    case 'add-event-shop':
      S.pendingEventId = el.dataset.eventId;
      S.pendingDate    = el.dataset.date;
      openModal('shopping');
      break;

    case 'add-event-todo':
      S.pendingEventId = el.dataset.eventId;
      S.pendingDate    = el.dataset.date;
      openModal('todo');
      break;

    // ── Shopping ──
    case 'toggle-shopping': {
      const item = DB.shopItem(id);
      if (item) { item.purchased = !item.purchased; DB.saveShop(item); renderDetail(); }
      break;
    }
    case 'edit-shopping':
      openModal('shopping', DB.shopItem(id)); break;

    case 'copy-shopping':
      openCopyModal('shopping', id); break;

    case 'delete-shopping':
      showConfirm('確定要刪除這個購物項目？', () => {
        DB.deleteShop(id); renderDetail();
      }); break;

    // ── Todo ──
    case 'toggle-todo': {
      const todo = DB.todo(id);
      if (todo) { todo.completed = !todo.completed; DB.saveTodo(todo); renderDetail(); }
      break;
    }
    case 'edit-todo':
      openModal('todo', DB.todo(id)); break;

    case 'copy-todo':
      openCopyModal('todo', id); break;

    case 'delete-todo':
      showConfirm('確定要刪除這個代辦事項？', () => {
        DB.deleteTodo(id); renderDetail();
      }); break;

    // ── Locations ──
    case 'add-loc-to-timeline':
      // Pre-fill the event modal with location name & address, let user pick the day
      openModal('event', {
        title:    el.dataset.name,
        location: el.dataset.addr,
        category: 'attraction',
      });
      break;

    case 'edit-location':
      openModal('location', DB.location(id)); break;

    case 'delete-location':
      showConfirm('確定要刪除這個地點？', () => {
        DB.deleteLoc(id); renderDetail();
      }); break;

    // ── Photos ──
    case 'pick-photo':
      $(`${el.dataset.kind}-photos-input`).click();
      break;

    case 'remove-photo':
      S.editPhotos.splice(Number(el.dataset.index), 1);
      renderPhotoStrip(S.modal);
      break;

    case 'view-photo':
      $('photo-lightbox-img').src = el.dataset.src;
      $('photo-lightbox').style.display = 'flex';
      break;
  }
});

document.addEventListener('change', e => {
  const input = e.target.closest('.photo-file-input');
  if (!input || !input.files.length) return;
  handlePhotoFiles(input.dataset.photoKind, [...input.files]);
  input.value = '';
});

$('photo-lightbox').addEventListener('click', () => {
  $('photo-lightbox').style.display = 'none';
});

// ─── Event Card Drag & Drop ───────────────────────────────────────────────────

let dragCtx = null;

document.addEventListener('pointerdown', e => {
  const handle = e.target.closest('[data-action="drag-noop"]');
  if (!handle) return;

  const ev = DB.event(handle.dataset.id);
  if (!ev) return;

  const card = handle.closest('.event-item');
  const rect = card.getBoundingClientRect();

  const ghost = card.cloneNode(true);
  ghost.classList.add('drag-ghost');
  const ghostWidth = Math.min(rect.width, window.innerWidth - 16);
  ghost.style.width = ghostWidth + 'px';
  ghost.style.left  = Math.min(rect.left, window.innerWidth - ghostWidth - 8) + 'px';
  ghost.style.top   = rect.top + 'px';
  document.body.appendChild(ghost);

  card.classList.add('drag-source-hidden');

  dragCtx = {
    ev, card, ghost,
    pointerId: e.pointerId,
    startX: e.clientX, startY: e.clientY,
    lastTarget: null,
  };

  handle.setPointerCapture(e.pointerId);
  e.preventDefault();
});

document.addEventListener('pointermove', e => {
  if (!dragCtx || e.pointerId !== dragCtx.pointerId) return;

  const dx = e.clientX - dragCtx.startX;
  const dy = e.clientY - dragCtx.startY;
  dragCtx.ghost.style.transform = `translate(${dx}px, ${dy}px)`;

  document.querySelectorAll('.drag-hover').forEach(el => el.classList.remove('drag-hover'));

  dragCtx.ghost.style.display = 'none';
  const under = document.elementFromPoint(e.clientX, e.clientY);
  dragCtx.ghost.style.display = '';

  const targetCard    = under?.closest('.event-item');
  const targetSection = under?.closest('.day-section[data-date]');

  if (targetCard && targetCard !== dragCtx.card) {
    targetCard.classList.add('drag-hover');
    dragCtx.lastTarget = { type: 'card', id: targetCard.dataset.id };
  } else if (targetSection) {
    targetSection.classList.add('drag-hover');
    dragCtx.lastTarget = { type: 'section', date: targetSection.dataset.date };
  } else {
    dragCtx.lastTarget = null;
  }
});

function endDrag(commit) {
  if (!dragCtx) return;
  document.querySelectorAll('.drag-hover').forEach(el => el.classList.remove('drag-hover'));

  if (commit) {
    const { ev, lastTarget } = dragCtx;

    if (lastTarget?.type === 'card' && lastTarget.id !== ev.id) {
      const target = DB.event(lastTarget.id);
      if (target) {
        if (target.date === ev.date) {
          const swapped = { start: target.startTime, end: target.endTime };
          const okA = confirmNoTimeConflict(ev.id, ev.date, swapped.start, swapped.end, [target.id]);
          const okB = okA && confirmNoTimeConflict(target.id, target.date, ev.startTime, ev.endTime, [ev.id]);
          if (okA && okB) {
            DB.saveEvent({ ...ev,     startTime: swapped.start, endTime: swapped.end });
            DB.saveEvent({ ...target, startTime: ev.startTime,  endTime: ev.endTime  });
          }
        } else if (confirmNoTimeConflict(ev.id, target.date, ev.startTime, ev.endTime)) {
          DB.saveEvent({ ...ev, date: target.date });
        }
      }
    } else if (lastTarget?.type === 'section' && lastTarget.date !== ev.date) {
      if (confirmNoTimeConflict(ev.id, lastTarget.date, ev.startTime, ev.endTime)) {
        DB.saveEvent({ ...ev, date: lastTarget.date });
      }
    }
  }

  dragCtx.ghost.remove();
  dragCtx.card.classList.remove('drag-source-hidden');
  dragCtx = null;
  renderDetail();
}

document.addEventListener('pointerup', e => {
  if (!dragCtx || e.pointerId !== dragCtx.pointerId) return;
  endDrag(true);
});

document.addEventListener('pointercancel', e => {
  if (!dragCtx || e.pointerId !== dragCtx.pointerId) return;
  endDrag(false);
});

// ─── Static Event Listeners ───────────────────────────────────────────────────

$('btn-back').addEventListener('click', () => {
  if (S.view === 'detail') backToTrips();
  else $('import-file-input').click();
});
$('btn-add').addEventListener('click', headerAdd);

$('import-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importTripFile(file);
});

$('btn-import-csv').addEventListener('click', () => $('csv-file-input').click());

$('csv-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importCsvFile(file);
});

$('event-has-time').addEventListener('change', e => {
  $('event-time-fields').style.display = e.target.checked ? '' : 'none';
  updateComputedEndTime();
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => setTab(btn.dataset.tab));
});

document.querySelectorAll('.modal-cancel').forEach(btn => {
  btn.addEventListener('click', closeModal);
});

document.querySelectorAll('.modal-done').forEach(btn => {
  btn.addEventListener('click', saveModal);
});

$('confirm-cancel').addEventListener('click', closeModal);
$('confirm-ok').addEventListener('click', () => {
  const cb = S.confirmCb;
  closeModal();
  if (cb) cb();
});

// Close modal when tapping overlay background
$('modal-overlay').addEventListener('click', e => {
  if (e.target === $('modal-overlay')) closeModal();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try {
    await migratePhotosToIndexedDB();
  } catch (err) {
    console.error('photo migration failed', err);
  }
  render();
});
