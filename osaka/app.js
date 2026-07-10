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

function buildTimeOptions(selected) {
  let html = '<option value="">-- 時間 --</option>';
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const t = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      html += `<option value="${t}"${t === selected ? ' selected' : ''}>${t}</option>`;
    }
  }
  return html;
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

// ─── Data Layer (localStorage) ───────────────────────────────────────────────

const DB = {
  _read(k)    { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } },
  _write(k,v) { localStorage.setItem(k, JSON.stringify(v)); },

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
    this._write('trips',     this.trips().filter(t => t.id !== id));
    this._write('events',    this._read('events').filter(e => e.tripId !== id));
    this._write('shopping',  this._read('shopping').filter(s => s.tripId !== id));
    this._write('todos',     this._read('todos').filter(t => t.tripId !== id));
    this._write('locations', this._read('locations').filter(l => l.tripId !== id));
  },

  // ── Events ──
  events(tripId)   { return this._read('events').filter(e => e.tripId === tripId); },
  event(id)        { return this._read('events').find(e => e.id === id); },
  saveEvent(ev)    { this._saveItem('events', ev); },
  deleteEvent(id)  { this._del('events', id); },

  // ── Shopping ──
  shopping(tripId) { return this._read('shopping').filter(s => s.tripId === tripId); },
  shopItem(id)     { return this._read('shopping').find(s => s.id === id); },
  saveShop(item)   { this._saveItem('shopping', item); },
  deleteShop(id)   { this._del('shopping', id); },

  // ── Todos ──
  todos(tripId)   { return this._read('todos').filter(t => t.tripId === tripId); },
  todo(id)        { return this._read('todos').find(t => t.id === id); },
  saveTodo(todo)  { this._saveItem('todos', todo); },
  deleteTodo(id)  { this._del('todos', id); },

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
  tab:            'timeline',
  modal:          null,
  editId:         null,
  pendingDate:    null,
  pendingEventId: null,
  confirmCb:      null,
};

// ─── DOM Shorthand ───────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// ─── Navigation ──────────────────────────────────────────────────────────────

function openTrip(id) {
  S.view = 'detail'; S.tripId = id; S.tab = 'timeline';
  render();
}

function backToTrips() {
  S.view = 'trips'; S.tripId = null;
  render();
}

function setTab(tab) { S.tab = tab; renderDetail(); syncTabBar(); }

// ─── Top-level Render ────────────────────────────────────────────────────────

function render() {
  const isDetail = S.view === 'detail';

  // Header
  $('btn-back').style.display = isDetail ? '' : 'none';
  $('header-title').textContent = isDetail
    ? (DB.trip(S.tripId)?.name || '行程') : '我的行程';

  // Screens
  $('screen-trips').style.display  = isDetail ? 'none' : '';
  $('screen-detail').style.display = isDetail ? '' : 'none';

  // Tab bar
  $('tab-bar').style.display = isDetail ? '' : 'none';

  if (isDetail) { renderDetail(); syncTabBar(); }
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

function renderDetail() {
  switch (S.tab) {
    case 'timeline': renderTimeline(); break;
    case 'shopping': renderShopping(); break;
    case 'todo':     renderTodo();     break;
  }
}

// ─── Timeline ────────────────────────────────────────────────────────────────

const CAT_ICON = {
  attraction:'🏛', food:'🍜', transport:'🚆',
  accommodation:'🏨', shopping:'🛍', other:'📌',
};

function renderTimeline() {
  const trip = DB.trip(S.tripId);
  const el   = $('screen-detail');

  if (!trip?.startDate || !trip?.endDate) {
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

  const days     = getDays(trip.startDate, trip.endDate);
  const events   = DB.events(S.tripId);
  const shopping = DB.shopping(S.tripId);
  const todos    = DB.todos(S.tripId);
  const WD       = ['日','一','二','三','四','五','六'];

  // Items added directly in Shopping/Todo tabs (no eventId) with no valid day-of-trip date
  const noDateShop = shopping.filter(s => !s.eventId && !(s.date && days.includes(s.date)));
  const noDateTodo = todos.filter(t => !t.eventId && !(t.assignedDate && days.includes(t.assignedDate)));
  const noDateHtml = standaloneListsHtml(noDateShop, noDateTodo);

  const html = days.map((day, i) => {
    const d        = new Date(day + 'T00:00:00');
    const label    = `第 ${i+1} 天 · ${d.getMonth()+1}/${d.getDate()} (週${WD[d.getDay()]})`;
    const dayEvs   = events
      .filter(e => e.date === day)
      .sort((a,b) => (a.startTime||'').localeCompare(b.startTime||''));

    // Items added directly in Shopping/Todo tabs for this day (no eventId)
    const dayShop        = shopping.filter(s => !s.eventId && s.date === day);
    const dayTodo        = todos.filter(t => !t.eventId && t.assignedDate === day);
    const standaloneHtml = standaloneListsHtml(dayShop, dayTodo);

    return `
      <div class="day-section">
        <div class="day-header">
          <span class="day-label">${esc(label)}</span>
          <button class="btn-add-inline" data-action="add-event" data-date="${esc(day)}">＋ 新增</button>
        </div>
        ${dayEvs.length
          ? dayEvs.map(eventItem).join('')
          : (standaloneHtml ? '' : `<div class="day-empty">尚無行程，點「新增」加入</div>`)}
        ${standaloneHtml}
      </div>`;
  }).join('');

  const noDateSection = noDateHtml ? `
    <div class="day-section">
      <div class="day-header"><span class="day-label">整個行程</span></div>
      ${noDateHtml}
    </div>` : '';

  el.innerHTML = `<div class="timeline-content">${noDateSection}${html}</div>`;
}

function standaloneListsHtml(shopItems, todoItems) {
  if (!shopItems.length && !todoItems.length) return '';
  return `
    ${shopItems.length ? `
      <div class="event-sub-header">🛒 購物（未排入行程項目）</div>
      <div class="item-list">${shopItems.map(shopItem).join('')}</div>` : ''}
    ${todoItems.length ? `
      <div class="event-sub-header">✅ 代辦（未排入行程項目）</div>
      <div class="item-list">${todoItems.sort(sortTodos).map(todoItem).join('')}</div>` : ''}
  `;
}

function eventItem(ev) {
  const icon    = CAT_ICON[ev.category] || '📌';
  const timeStr = ev.startTime
    ? (ev.endTime ? `${ev.startTime}–${ev.endTime}` : ev.startTime)
    : '';

  const shopItems = DB.shopping(S.tripId).filter(s => s.eventId === ev.id);
  const todoItems = DB.todos(S.tripId).filter(t => t.eventId === ev.id);

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
      <div class="event-icon">${icon}</div>
      <div class="event-body">
        <div class="event-title">${esc(ev.title)}</div>
        ${timeStr     ? `<div class="event-meta">⏰ ${esc(timeStr)}</div>`    : ''}
        ${ev.location ? `<div class="event-meta">📍 ${esc(ev.location)}</div>`: ''}
        ${ev.notes    ? `<div class="event-notes">${esc(ev.notes)}</div>`     : ''}
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
    </div>`;
}

// ─── Shopping ────────────────────────────────────────────────────────────────

function renderShopping() {
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

  days.forEach((day, i) => {
    const dayItems = byDate[day];
    if (!dayItems?.length) return;
    const d = new Date(day + 'T00:00:00');
    html += `<div class="day-group-header">第${i+1}天 · ${d.getMonth()+1}/${d.getDate()} (週${WD[d.getDay()]})</div>`;

    const dayEvs = allEvs.filter(e => e.date === day)
      .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    const shown = new Set();
    dayEvs.forEach(ev => {
      const evItems = dayItems.filter(item => item.eventId === ev.id);
      if (!evItems.length) return;
      const t = ev.startTime ? `${ev.startTime} ` : '';
      html += `<div class="event-sub-header">${esc(t + ev.title)}</div>
               <div class="item-list">${evItems.map(shopItem).join('')}</div>`;
      evItems.forEach(item => shown.add(item.id));
    });
    const orphans = dayItems.filter(item => !shown.has(item.id));
    if (orphans.length) {
      html += `<div class="event-sub-header">其他</div>
               <div class="item-list">${orphans.map(shopItem).join('')}</div>`;
    }
  });

  if (noDate.length) {
    html += `<div class="day-group-header">整個行程</div>
             <div class="item-list">${noDate.map(shopItem).join('')}</div>`;
  }

  $('screen-detail').innerHTML = html;
}

function shopItem(item) {
  const meta = [
    item.qty      ? `數量：${esc(item.qty)}`   : '',
    item.price    ? `¥${esc(item.price)}`      : '',
    item.category ? esc(item.category)         : '',
  ].filter(Boolean).join(' · ');

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
      </div>
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

function renderTodo() {
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

  days.forEach((day, i) => {
    const dayTodos = byDate[day];
    if (!dayTodos?.length) return;
    const d = new Date(day + 'T00:00:00');
    html += `<div class="day-group-header">第${i+1}天 · ${d.getMonth()+1}/${d.getDate()} (週${WD[d.getDay()]})</div>`;

    const dayEvs = allEvs.filter(e => e.date === day)
      .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    const shown = new Set();
    dayEvs.forEach(ev => {
      const evTodos = dayTodos.filter(t => t.eventId === ev.id);
      if (!evTodos.length) return;
      const ti = ev.startTime ? `${ev.startTime} ` : '';
      html += `<div class="event-sub-header">${esc(ti + ev.title)}</div>
               <div class="item-list">${evTodos.sort(sortTodos).map(todoItem).join('')}</div>`;
      evTodos.forEach(t => shown.add(t.id));
    });
    const orphans = dayTodos.filter(t => !shown.has(t.id)).sort(sortTodos);
    if (orphans.length) {
      html += `<div class="event-sub-header">其他</div>
               <div class="item-list">${orphans.map(todoItem).join('')}</div>`;
    }
  });

  if (noDate.length) {
    html += `<div class="day-group-header">整個行程</div>
             <div class="item-list">${noDate.sort(sortTodos).map(todoItem).join('')}</div>`;
  }

  $('screen-detail').innerHTML = html;
}

function todoItem(todo) {
  const p    = PRIO[todo.priority] || PRIO.medium;
  const meta = [
    `<span class="priority-emoji">${p.emoji}</span>${p.label}`,
    todo.dueDate ? `截止 ${formatDate(todo.dueDate)}` : '',
  ].filter(Boolean).join(' · ');

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
      </div>
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

function fillEventForm(ev) {
  $('modal-event-title').textContent    = ev?.id ? '編輯行程項目' : '新增行程項目';
  $('event-title-input').value          = ev?.title     || '';
  $('event-date').value                   = ev?.date     || S.pendingDate || '';
  $('event-start-time').innerHTML        = buildTimeOptions(ev?.startTime || '');
  $('event-end-time').innerHTML          = buildTimeOptions(ev?.endTime   || '');
  $('event-location-input').value       = ev?.location  || '';
  $('event-category').value             = ev?.category  || 'attraction';
  $('event-notes').value                = ev?.notes     || '';
  S.pendingDate = null;
}

function fillShoppingForm(item) {
  $('modal-shopping-title').textContent = item ? '編輯購物項目' : '新增購物項目';
  $('shopping-name').value     = item?.name     || '';
  $('shopping-qty').value      = item?.qty      || '';
  $('shopping-price').value    = item?.price    || '';
  $('shopping-category').value = item?.category || '';
  $('shopping-notes').value    = item?.notes    || '';
  $('shopping-date').innerHTML = buildDayOptions(S.tripId, item?.date || S.pendingDate || '');
}

function fillTodoForm(todo) {
  $('modal-todo-title').textContent = todo ? '編輯代辦事項' : '新增代辦事項';
  $('todo-title-input').value = todo?.title        || '';
  $('todo-due').value         = todo?.dueDate      || '';
  $('todo-priority').value    = todo?.priority     || 'medium';
  $('todo-notes').value       = todo?.notes        || '';
  $('todo-assigned-date').innerHTML = buildDayOptions(S.tripId, todo?.assignedDate || S.pendingDate || '');
}

function fillMoveEventForm(ev) {
  $('move-event-date').innerHTML = buildDayOptions(S.tripId, ev?.date || '');
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
  S.pendingDate = null; S.pendingEventId = null;
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
  });
  closeModal();
  renderDetail();
}

function confirmNoTimeConflict(excludeId, date, startTime, endTime) {
  if (!date || !startTime || !endTime) return true;
  const conflicts = DB.events(S.tripId).filter(ev => {
    if (ev.id === excludeId || ev.date !== date) return false;
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
  });
  closeModal();
  renderDetail();
}

function saveTodoForm() {
  const title = $('todo-title-input').value.trim();
  if (!title) { alert('請輸入事項名稱'); return; }
  const existing = S.editId ? DB.todo(S.editId) : null;
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
  });
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
  const map = { timeline:'event', shopping:'shopping', todo:'todo' };
  openModal(map[S.tab]);
}

// ─── Event Delegation ────────────────────────────────────────────────────────

document.addEventListener('click', e => {
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

    case 'delete-trip':
      showConfirm('確定要刪除這個行程？\n（所有相關資料都會一起刪除）', () => {
        DB.deleteTrip(id); render();
      }); break;

    // ── Events ──
    case 'add-event':
      S.pendingDate = date; openModal('event'); break;

    case 'edit-event':
      openModal('event', DB.event(id)); break;

    case 'move-event':
      openModal('move-event', DB.event(id)); break;

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
  }
});

// ─── Static Event Listeners ───────────────────────────────────────────────────

$('btn-back').addEventListener('click', backToTrips);
$('btn-add').addEventListener('click', headerAdd);

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

window.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  render();
});
