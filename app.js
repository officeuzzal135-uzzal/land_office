// ══════════════════════════════════════════
//  ভূমি অফিস ব্যবস্থাপনা — DATA STORE
// ══════════════════════════════════════════
const STORAGE_KEY = 'land_office_data_v1';
const PIN_KEY = 'land_office_pin_v1'; // পিন আলাদা key এ রাখা হচ্ছে — Firebase এ sync হয় না, শুধু এই ব্রাউজারে থাকে
const DEFAULT_PIN = '2026';
const FB_PATH = 'office/data'; // personal vault এর Firebase প্রজেক্টেই আলাদা path এ অফিসের ডেটা থাকবে

let fbApp = null;
let fbDb = null;

let DB = {
  haat: [],         // {id, name, case, haatName, total, due, date, dcr, status: 'pending'|'done'}
  vp: [],           // {id, name, case, mouza, total, due, date, dcr, status}
  chithi: [],       // {id, smarok, subject, sender, receiver, date, comment}
  kaj: [],          // {id, title, detail, status, date, done}
  notes: [],        // {id, title, body, date}
  diary: [],        // {id, date, text}
  paid: [],         // {id, type, name, amount, due, date, detail, progress, done}
  mutation: [],     // {id, name, case, amount, due, note, done}
  archive: {        // archived items grouped by type
    haat: [], vp: [], chithi: [], kaj: [], paid: [], mutation: []
  },
  // 'deleted' = active list থেকে সরানো (archive এ থাকে এটার ভিত্তিতে) — sync এ active list এ আবার ফিরে না আসে
  // (note, diary এখানে যুক্ত করা হয়েছে যাতে এগুলো ডিলিট করলে Firebase sync এর সময় আর ফিরে না আসে — আগের বাগ ফিক্স)
  deleted: { haat: {}, vp: {}, chithi: {}, kaj: {}, paid: {}, mutation: {}, notes: {}, diary: {} },
  // 'purged' = স্থায়ীভাবে সব জায়গা থেকে মুছে ফেলা (active + archive দুই জায়গা থেকেই) — শুধু permanent delete এর জন্য
  purged: { haat: {}, vp: {}, chithi: {}, kaj: {}, paid: {}, mutation: {}, notes: {}, diary: {} },
  settings: { tgToken: '', tgChatId: '', fbConfig: null }
};

function loadDB() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      DB = {
        ...DB, ...parsed,
        archive: { ...DB.archive, ...(parsed.archive || {}) },
        deleted: { ...DB.deleted, ...(parsed.deleted || {}) },
        purged: { ...DB.purged, ...(parsed.purged || {}) },
        settings: { ...DB.settings, ...(parsed.settings || {}) }
      };
      purgeDeletedEverywhere(); // লোকাল ডেটাতেও tombstone থাকা সত্ত্বেও কোনো item থেকে গেলে পরিষ্কার করে নেওয়া
    }
  } catch (e) { console.warn('লোড করতে সমস্যা হয়েছে:', e); }
}

function saveDB() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DB));
  } catch (e) { console.warn('সংরক্ষণ করতে সমস্যা হয়েছে:', e); }
  window._lastLocalUpdate = Date.now();
  if (fbDb) {
    clearTimeout(window._fbDebounce);
    window._fbDebounce = setTimeout(pushToFirebase, 4000);
  }
}

// শুধু localStorage এ সংরক্ষণ করে — Firebase push ট্রিগার করে না।
// remote থেকে ডেটা আসার পর (pull/listener) এটা ব্যবহার করা হয়, যাতে নিজের শোনা ডেটা আবার নিজেই push না করে ফেলে (loop আটকাতে)
function saveLocalOnly() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DB));
  } catch (e) { console.warn('সংরক্ষণ করতে সমস্যা হয়েছে:', e); }
}

// আর্কাইভ করার সময় ব্যবহার হয় — শুধু active list (DB.haat ইত্যাদি) থেকে বাদ থাকবে, কিন্তু archive এ থেকে যাবে
function markDeleted(type, id) {
  DB.deleted[type] = DB.deleted[type] || {};
  DB.deleted[type][id] = Date.now();
}

// স্থায়ী মুছে ফেলার সময় ব্যবহার হয় — active list এবং archive দুই জায়গা থেকেই একদম চিরতরে বাদ যাবে
function markPurged(type, id) {
  DB.purged[type] = DB.purged[type] || {};
  DB.purged[type][id] = Date.now();
}

// tombstone-যুক্ত কাজ (archive/permanent-delete) এর পর দেরি না করে সাথে সাথে Firebase এ push করে —
// যাতে অন্য ট্যাব/ডিভাইস/Telegram বট দ্রুত tombstone টা পায় এবং পুরোনো ডেটা merge হয়ে আবার ফিরে না আসে
function pushNow() {
  if (fbDb) { clearTimeout(window._fbDebounce); pushToFirebase(); }
}

function uid() { return Date.now() + Math.floor(Math.random() * 1000); }

// ══════════════════════════════════════════
//  PIN LOCK
// ══════════════════════════════════════════
function getSavedPin() {
  try {
    return localStorage.getItem(PIN_KEY) || DEFAULT_PIN;
  } catch { return DEFAULT_PIN; }
}

function checkPin() {
  const input = document.getElementById('pin-input');
  const entered = input.value.trim();
  const correct = getSavedPin();
  const errorBox = document.getElementById('pin-error');

  if (!entered) {
    errorBox.textContent = 'পিন লিখুন';
    return;
  }
  if (entered === correct) {
    document.getElementById('pin-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    errorBox.textContent = '';
    input.value = '';
    try { sessionStorage.setItem('land_office_unlocked', '1'); } catch {}
  } else {
    errorBox.textContent = '❌ ভুল পিন, আবার চেষ্টা করুন';
    input.value = '';
    input.focus();
  }
}

function changePin() {
  const current = document.getElementById('pin-current').value.trim();
  const next = document.getElementById('pin-new').value.trim();
  const statusEl = document.getElementById('pin-change-status');
  const correct = getSavedPin();

  if (current !== correct) {
    statusEl.innerHTML = '<span class="status-badge err">✗ বর্তমান পিন ভুল</span>';
    return;
  }
  if (!next || next.length < 4) {
    statusEl.innerHTML = '<span class="status-badge err">✗ নতুন পিন কমপক্ষে ৪ সংখ্যার হতে হবে</span>';
    return;
  }
  try {
    localStorage.setItem(PIN_KEY, next);
    statusEl.innerHTML = '<span class="status-badge ok">✓ পিন পরিবর্তিত হয়েছে</span>';
    document.getElementById('pin-current').value = '';
    document.getElementById('pin-new').value = '';
    showToast('🔐 পিন সফলভাবে পরিবর্তিত হয়েছে');
  } catch {
    statusEl.innerHTML = '<span class="status-badge err">✗ সংরক্ষণ ব্যর্থ</span>';
  }
}

// ══════════════════════════════════════════
//  TAB NAVIGATION
// ══════════════════════════════════════════
function showTab(tab) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('section-' + tab).classList.add('active');
  const idx = ['dashboard','haat','vp','chithi','kaj','diary','more','news','archive','settings'].indexOf(tab);
  const tabs = document.querySelectorAll('.nav-tab');
  if (tabs[idx]) tabs[idx].classList.add('active');
  if (tab === 'more') backToMoreHub();
  if (tab === 'news') {
    // নিউজ ট্যাব খুললে স্বয়ংক্রিয়ভাবে লোড হবে
    if (allNewsItems.length === 0) {
      loadNews(false);
    } else {
      renderNewsList(allNewsItems);
    }
  }
  renderAll();
}

function showDiarySub(which) {
  document.getElementById('diary-sub-note').classList.toggle('active', which === 'note');
  document.getElementById('diary-sub-diary').classList.toggle('active', which === 'diary');
  document.getElementById('diary-pane-note').style.display = which === 'note' ? 'block' : 'none';
  document.getElementById('diary-pane-diary').style.display = which === 'diary' ? 'block' : 'none';
}

function openMoreSubtab(which) {
  showTab('more');
  document.getElementById('more-hub').style.display = 'none';
  document.getElementById('more-paid').style.display = which === 'paid' ? 'block' : 'none';
  document.getElementById('more-mutation').style.display = which === 'mutation' ? 'block' : 'none';
}
function backToMoreHub() {
  document.getElementById('more-hub').style.display = 'block';
  document.getElementById('more-paid').style.display = 'none';
  document.getElementById('more-mutation').style.display = 'none';
}

// ══════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
function openModalEl(id) { document.getElementById(id).classList.add('show'); }

function showToast(msg, type = 'success') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// তারিখ ফরম্যাট: 14 Jun 26
function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr + (dateStr.length === 10 ? 'T00:00:00' : ''));
    const day = d.getDate();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const month = months[d.getMonth()];
    const year = String(d.getFullYear()).slice(-2);
    return `${day} ${month} ${year}`;
  } catch { return dateStr; }
}

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function money(n) {
  n = Number(n) || 0;
  return '৳' + n.toLocaleString('en-IN');
}

function toggleManual(prefix) {
  const sel = document.getElementById(prefix + '-select');
  const manual = document.getElementById(prefix + '-manual');
  manual.style.display = sel.value === 'manual' ? 'block' : 'none';
}

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ══════════════════════════════════════════
//  রিমাইন্ডার — হেল্পার ফাংশন (সব মডিউলে রিইউজ করার জন্য)
// ══════════════════════════════════════════
// HTML input[type=datetime-local] থেকে মান নিয়ে আসে; খালি থাকলে '' রিটার্ন করে (no reminder)
function getReminderInput(prefix) {
  const el = document.getElementById(prefix + '-reminder');
  return el ? el.value : '';
}
// edit মোডে আগের রিমাইন্ডার মান বসিয়ে দেয়
function setReminderInput(prefix, value) {
  const el = document.getElementById(prefix + '-reminder');
  if (el) el.value = value || '';
}
// একটা আইটেমের রিমাইন্ডার পেন্ডিং কিনা (ভবিষ্যতে আছে, এখনও পাঠানো হয়নি) — কার্ডে দেখানোর জন্য
function reminderStatus(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  const now = Date.now();
  const diffH = (t - now) / 3600000;
  if (diffH < 0) return 'overdue';
  if (diffH <= 24) return 'today';
  return 'upcoming';
}
function reminderLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const dateStr = d.toLocaleDateString('bn-BD', { day: 'numeric', month: 'short', year: 'numeric' });
  const timeStr = d.toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' });
  return `${dateStr}, ${timeStr}`;
}
// একটা আইটেমে নতুন ডেটা apply করার সময় — যদি রিমাইন্ডার এর তারিখ/সময় বদলায়, তাহলে আগের
// reminderSent ফ্ল্যাগ রিসেট হয়ে যায়, যাতে নতুন সময়ে আবার ঠিকমতো নোটিফিকেশন যায়
function applyWithReminderReset(item, data) {
  const reminderChanged = (item.reminder || '') !== (data.reminder || '');
  Object.assign(item, data);
  if (reminderChanged) item.reminderSent = false;
}

// কোনো আইটেমে রিমাইন্ডার থাকলে কার্ডে ছোট পিল হিসেবে দেখানোর HTML
function reminderBadgeHTML(iso) {
  if (!iso) return '';
  const status = reminderStatus(iso);
  if (!status) return '';
  const cls = status === 'overdue' ? 'overdue' : status === 'today' ? 'today' : 'upcoming';
  const label = status === 'overdue' ? 'মিস হয়েছে' : status === 'today' ? 'আজ/২৪ ঘণ্টার মধ্যে' : 'আসছে';
  return `<span class="reminder-pill ${cls}" title="${esc(reminderLabel(iso))}">🔔 ${label} · ${esc(reminderLabel(iso))}</span>`;
}

// ══════════════════════════════════════════
//  HAAT-BAZAR
// ══════════════════════════════════════════
let haatFilter = 'all';
function filterHaat(f, btn) {
  haatFilter = f;
  document.querySelectorAll('#haat-filter-row .filter-chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  renderHaat();
}

function openHaatModal(id) {
  document.getElementById('haat-modal-title').textContent = id ? 'হাট-বাজার এন্ট্রি সম্পাদনা' : 'হাট-বাজার নতুন এন্ট্রি';
  document.getElementById('haat-id').value = id || '';
  if (id) {
    const item = DB.haat.find(i => i.id == id);
    document.getElementById('haat-name').value = item.name || '';
    document.getElementById('haat-case').value = item.case || '';
    document.getElementById('haat-name-select').value = item.haatName || 'খাজুরা';
    document.getElementById('haat-total').value = item.total || '';
    document.getElementById('haat-due').value = item.due || '';
    document.getElementById('haat-date').value = item.date || '';
    document.getElementById('haat-dcr').value = item.dcr || '';
    setReminderInput('haat', item.reminder);
  } else {
    document.getElementById('haat-name').value = '';
    document.getElementById('haat-case').value = '';
    document.getElementById('haat-name-select').value = 'খাজুরা';
    document.getElementById('haat-total').value = '';
    document.getElementById('haat-due').value = '';
    document.getElementById('haat-date').value = todayISO();
    document.getElementById('haat-dcr').value = '';
    setReminderInput('haat', '');
  }
  openModalEl('haat-modal');
}

function saveHaat() {
  const id = document.getElementById('haat-id').value;
  const name = document.getElementById('haat-name').value.trim();
  if (!name) { showToast('আবেদনকারীর নাম লিখুন', 'error'); return; }
  const data = {
    name,
    case: document.getElementById('haat-case').value.trim(),
    haatName: document.getElementById('haat-name-select').value,
    total: Number(document.getElementById('haat-total').value) || 0,
    due: Number(document.getElementById('haat-due').value) || 0,
    date: document.getElementById('haat-date').value || todayISO(),
    dcr: document.getElementById('haat-dcr').value.trim(),
    reminder: getReminderInput('haat'),
  };
  if (id) {
    const item = DB.haat.find(i => i.id == id);
    applyWithReminderReset(item, data);
  } else {
    DB.haat.unshift({ id: uid(), status: 'pending', reminderSent: false, ...data });
  }
  saveDB(); renderAll(); closeModal('haat-modal');
  showToast('✅ হাট-বাজার এন্ট্রি সংরক্ষিত হয়েছে');
}

function markHaatDone(id) {
  const item = DB.haat.find(i => i.id == id);
  if (item) { item.status = 'done'; saveDB(); renderAll(); showToast('✅ সম্পন্ন হিসেবে চিহ্নিত হয়েছে'); }
}
function archiveHaat(id) {
  const idx = DB.haat.findIndex(i => i.id == id);
  if (idx === -1) return;
  const [item] = DB.haat.splice(idx, 1);
  item.archivedAt = Date.now();
  DB.archive.haat.unshift(item);
  markDeleted('haat', id); // active list থেকে সরানো হলো — sync এ যেন remote থেকে আবার ফিরে না আসে
  saveDB(); renderAll(); pushNow(); showToast('🗄️ আর্কাইভে সরানো হয়েছে');
}

function renderHaat() {
  const list = document.getElementById('haat-list');
  let items = DB.haat;
  if (haatFilter !== 'all') items = items.filter(i => i.status === haatFilter);
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🛒</div><div class="empty-text">কোনো এন্ট্রি নেই</div></div>`;
  } else {
    list.innerHTML = items.map(i => `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${esc(i.name)}</div>
            <div class="card-meta">হাট: ${esc(i.haatName)} ${i.case ? '· কেস: ' + esc(i.case) : ''}</div>
          </div>
          <span class="status-badge ${i.status === 'done' ? 'ok' : 'pending'}">${i.status === 'done' ? 'সম্পন্ন' : 'চলমান'}</span>
        </div>
        <div class="card-body-row">
          <div class="item">মোট টাকা: <b>${money(i.total)}</b></div>
          <div class="item">বকেয়া: <b>${money(i.due)}</b></div>
          <div class="item">তারিখ: <b>${formatDate(i.date)}</b></div>
          ${i.dcr ? `<div class="item">DCR: <b>${esc(i.dcr)}</b></div>` : ''}
        </div>
        ${i.reminder ? `<div class="card-body-row">${reminderBadgeHTML(i.reminder)}</div>` : ''}
        <div class="card-actions">
          <button class="btn-ghost" onclick="openHaatModal(${i.id})">✏️ সম্পাদনা</button>
          ${i.status !== 'done' ? `<button class="btn-success" onclick="markHaatDone(${i.id})">✓ সম্পন্ন</button>` : ''}
          <button class="btn-danger" onclick="archiveHaat(${i.id})">🗄️ আর্কাইভ</button>
        </div>
      </div>
    `).join('');
  }
  document.getElementById('haat-total-joma').textContent = money(DB.haat.reduce((s,i)=>s+i.total,0));
  document.getElementById('haat-total-bokeya').textContent = money(DB.haat.reduce((s,i)=>s+i.due,0));
  document.getElementById('haat-total-count').textContent = DB.haat.length;
}

// ══════════════════════════════════════════
//  VP
// ══════════════════════════════════════════
let vpFilter = 'all';
function filterVp(f, btn) {
  vpFilter = f;
  document.querySelectorAll('#vp-filter-row .filter-chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  renderVp();
}

function openVpModal(id) {
  document.getElementById('vp-modal-title').textContent = id ? 'ভিপি এন্ট্রি সম্পাদনা' : 'ভিপি নতুন এন্ট্রি';
  document.getElementById('vp-id').value = id || '';
  if (id) {
    const item = DB.vp.find(i => i.id == id);
    document.getElementById('vp-name').value = item.name || '';
    document.getElementById('vp-case').value = item.case || '';
    document.getElementById('vp-mouza').value = item.mouza || '';
    document.getElementById('vp-total').value = item.total || '';
    document.getElementById('vp-due').value = item.due || '';
    document.getElementById('vp-date').value = item.date || '';
    document.getElementById('vp-dcr').value = item.dcr || '';
    setReminderInput('vp', item.reminder);
  } else {
    document.getElementById('vp-name').value = '';
    document.getElementById('vp-case').value = '';
    document.getElementById('vp-mouza').value = '';
    document.getElementById('vp-total').value = '';
    document.getElementById('vp-due').value = '';
    document.getElementById('vp-date').value = todayISO();
    document.getElementById('vp-dcr').value = '';
    setReminderInput('vp', '');
  }
  openModalEl('vp-modal');
}

function saveVp() {
  const id = document.getElementById('vp-id').value;
  const name = document.getElementById('vp-name').value.trim();
  if (!name) { showToast('আবেদনকারীর নাম লিখুন', 'error'); return; }
  const data = {
    name,
    case: document.getElementById('vp-case').value.trim(),
    mouza: document.getElementById('vp-mouza').value.trim(),
    total: Number(document.getElementById('vp-total').value) || 0,
    due: Number(document.getElementById('vp-due').value) || 0,
    date: document.getElementById('vp-date').value || todayISO(),
    dcr: document.getElementById('vp-dcr').value.trim(),
    reminder: getReminderInput('vp'),
  };
  if (id) {
    const item = DB.vp.find(i => i.id == id);
    applyWithReminderReset(item, data);
  } else {
    DB.vp.unshift({ id: uid(), status: 'pending', reminderSent: false, ...data });
  }
  saveDB(); renderAll(); closeModal('vp-modal');
  showToast('✅ ভিপি এন্ট্রি সংরক্ষিত হয়েছে');
}

function markVpDone(id) {
  const item = DB.vp.find(i => i.id == id);
  if (item) { item.status = 'done'; saveDB(); renderAll(); showToast('✅ সম্পন্ন হিসেবে চিহ্নিত হয়েছে'); }
}
function archiveVp(id) {
  const idx = DB.vp.findIndex(i => i.id == id);
  if (idx === -1) return;
  const [item] = DB.vp.splice(idx, 1);
  item.archivedAt = Date.now();
  DB.archive.vp.unshift(item);
  markDeleted('vp', id);
  saveDB(); renderAll(); pushNow(); showToast('🗄️ আর্কাইভে সরানো হয়েছে');
}

function renderVp() {
  const list = document.getElementById('vp-list');
  let items = DB.vp;
  if (vpFilter !== 'all') items = items.filter(i => i.status === vpFilter);
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🗺️</div><div class="empty-text">কোনো এন্ট্রি নেই</div></div>`;
  } else {
    list.innerHTML = items.map(i => `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${esc(i.name)}</div>
            <div class="card-meta">মৌজা নং: ${esc(i.mouza)} ${i.case ? '· কেস: ' + esc(i.case) : ''}</div>
          </div>
          <span class="status-badge ${i.status === 'done' ? 'ok' : 'pending'}">${i.status === 'done' ? 'সম্পন্ন' : 'চলমান'}</span>
        </div>
        <div class="card-body-row">
          <div class="item">মোট টাকা: <b>${money(i.total)}</b></div>
          <div class="item">বকেয়া: <b>${money(i.due)}</b></div>
          <div class="item">তারিখ: <b>${formatDate(i.date)}</b></div>
          ${i.dcr ? `<div class="item">DCR: <b>${esc(i.dcr)}</b></div>` : ''}
        </div>
        ${i.reminder ? `<div class="card-body-row">${reminderBadgeHTML(i.reminder)}</div>` : ''}
        <div class="card-actions">
          <button class="btn-ghost" onclick="openVpModal(${i.id})">✏️ সম্পাদনা</button>
          ${i.status !== 'done' ? `<button class="btn-success" onclick="markVpDone(${i.id})">✓ সম্পন্ন</button>` : ''}
          <button class="btn-danger" onclick="archiveVp(${i.id})">🗄️ আর্কাইভ</button>
        </div>
      </div>
    `).join('');
  }
  document.getElementById('vp-total-joma').textContent = money(DB.vp.reduce((s,i)=>s+i.total,0));
  document.getElementById('vp-total-bokeya').textContent = money(DB.vp.reduce((s,i)=>s+i.due,0));
  document.getElementById('vp-total-count').textContent = DB.vp.length;
}

// ══════════════════════════════════════════
//  CHITHIPOTRO (LETTERS)
// ══════════════════════════════════════════
function openChithiModal(id) {
  document.getElementById('chithi-modal-title').textContent = id ? 'চিঠি সম্পাদনা' : 'নতুন চিঠি';
  document.getElementById('chithi-id').value = id || '';
  const senderSel = document.getElementById('chithi-sender-select');
  const receiverSel = document.getElementById('chithi-receiver-select');
  if (id) {
    const item = DB.chithi.find(i => i.id == id);
    document.getElementById('chithi-smarok').value = item.smarok || '';
    document.getElementById('chithi-subject').value = item.subject || '';
    document.getElementById('chithi-date').value = item.date || '';
    document.getElementById('chithi-comment').value = item.comment || '';
    setReminderInput('chithi', item.reminder);

    if (['UNO','ADC(R)','ULAO'].includes(item.sender)) {
      senderSel.value = item.sender;
      document.getElementById('chithi-sender-manual').style.display = 'none';
    } else {
      senderSel.value = 'manual';
      document.getElementById('chithi-sender-manual').style.display = 'block';
      document.getElementById('chithi-sender-manual').value = item.sender || '';
    }
    if (['UNO','ADC(R)','ULAO'].includes(item.receiver)) {
      receiverSel.value = item.receiver;
      document.getElementById('chithi-receiver-manual').style.display = 'none';
    } else {
      receiverSel.value = 'manual';
      document.getElementById('chithi-receiver-manual').style.display = 'block';
      document.getElementById('chithi-receiver-manual').value = item.receiver || '';
    }
  } else {
    document.getElementById('chithi-smarok').value = '';
    document.getElementById('chithi-subject').value = '';
    document.getElementById('chithi-date').value = todayISO();
    document.getElementById('chithi-comment').value = '';
    senderSel.value = 'UNO';
    receiverSel.value = 'UNO';
    document.getElementById('chithi-sender-manual').style.display = 'none';
    document.getElementById('chithi-receiver-manual').style.display = 'none';
    document.getElementById('chithi-sender-manual').value = '';
    document.getElementById('chithi-receiver-manual').value = '';
    setReminderInput('chithi', '');
  }
  openModalEl('chithi-modal');
}

function saveChithi() {
  const id = document.getElementById('chithi-id').value;
  const subject = document.getElementById('chithi-subject').value.trim();
  if (!subject) { showToast('চিঠির বিষয় লিখুন', 'error'); return; }
  const senderSel = document.getElementById('chithi-sender-select').value;
  const receiverSel = document.getElementById('chithi-receiver-select').value;
  const sender = senderSel === 'manual' ? document.getElementById('chithi-sender-manual').value.trim() : senderSel;
  const receiver = receiverSel === 'manual' ? document.getElementById('chithi-receiver-manual').value.trim() : receiverSel;
  const data = {
    smarok: document.getElementById('chithi-smarok').value.trim(),
    subject,
    sender,
    receiver,
    date: document.getElementById('chithi-date').value || todayISO(),
    comment: document.getElementById('chithi-comment').value.trim(),
    reminder: getReminderInput('chithi'),
  };
  if (id) {
    const item = DB.chithi.find(i => i.id == id);
    applyWithReminderReset(item, data);
  } else {
    DB.chithi.unshift({ id: uid(), reminderSent: false, ...data });
  }
  saveDB(); renderAll(); closeModal('chithi-modal');
  showToast('✅ চিঠি সংরক্ষিত হয়েছে');
}

function archiveChithi(id) {
  const idx = DB.chithi.findIndex(i => i.id == id);
  if (idx === -1) return;
  const [item] = DB.chithi.splice(idx, 1);
  item.archivedAt = Date.now();
  DB.archive.chithi.unshift(item);
  markDeleted('chithi', id);
  saveDB(); renderAll(); pushNow(); showToast('🗄️ আর্কাইভে সরানো হয়েছে');
}

function renderChithi() {
  const list = document.getElementById('chithi-list');
  if (!DB.chithi.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">✉️</div><div class="empty-text">কোনো চিঠি নেই</div></div>`;
    return;
  }
  list.innerHTML = DB.chithi.map(i => `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${esc(i.subject)}</div>
          <div class="card-meta">স্মারক নং: ${esc(i.smarok) || '—'}</div>
        </div>
        <span class="status-badge info">${formatDate(i.date)}</span>
      </div>
      <div class="card-body-row">
        <div class="item">প্রেরণকারী: <b>${esc(i.sender)}</b></div>
        <div class="item">প্রাপক: <b>${esc(i.receiver)}</b></div>
      </div>
      ${i.comment ? `<div class="card-body-row"><div class="item" style="width:100%">মন্তব্য: <b>${esc(i.comment)}</b></div></div>` : ''}
      ${i.reminder ? `<div class="card-body-row">${reminderBadgeHTML(i.reminder)}</div>` : ''}
      <div class="card-actions">
        <button class="btn-ghost" onclick="openChithiModal(${i.id})">✏️ সম্পাদনা</button>
        <button class="btn-danger" onclick="archiveChithi(${i.id})">🗄️ আর্কাইভ</button>
      </div>
    </div>
  `).join('');
}

// ══════════════════════════════════════════
//  KAJ (TASKS)
// ══════════════════════════════════════════
let kajFilter = 'all';
function filterKaj(f, btn) {
  kajFilter = f;
  document.querySelectorAll('#section-kaj .filter-chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  renderKaj();
}

function openKajModal(id) {
  document.getElementById('kaj-modal-title').textContent = id ? 'কাজ সম্পাদনা' : 'নতুন কাজ';
  document.getElementById('kaj-id').value = id || '';
  if (id) {
    const item = DB.kaj.find(i => i.id == id);
    document.getElementById('kaj-title').value = item.title || '';
    document.getElementById('kaj-detail').value = item.detail || '';
    document.getElementById('kaj-status').value = item.status || '';
    document.getElementById('kaj-date').value = item.date || '';
    setReminderInput('kaj', item.reminder);
  } else {
    document.getElementById('kaj-title').value = '';
    document.getElementById('kaj-detail').value = '';
    document.getElementById('kaj-status').value = '';
    document.getElementById('kaj-date').value = todayISO();
    setReminderInput('kaj', '');
  }
  openModalEl('kaj-modal');
}

function saveKaj() {
  const id = document.getElementById('kaj-id').value;
  const title = document.getElementById('kaj-title').value.trim();
  if (!title) { showToast('কাজের শিরোনাম লিখুন', 'error'); return; }
  const data = {
    title,
    detail: document.getElementById('kaj-detail').value.trim(),
    status: document.getElementById('kaj-status').value.trim(),
    date: document.getElementById('kaj-date').value || todayISO(),
    reminder: getReminderInput('kaj'),
  };
  if (id) {
    const item = DB.kaj.find(i => i.id == id);
    applyWithReminderReset(item, data);
  } else {
    DB.kaj.unshift({ id: uid(), done: false, reminderSent: false, ...data });
  }
  saveDB(); renderAll(); closeModal('kaj-modal');
  showToast('✅ কাজ সংরক্ষিত হয়েছে');
}

function markKajDone(id) {
  const item = DB.kaj.find(i => i.id == id);
  if (item) { item.done = true; saveDB(); renderAll(); showToast('✅ কাজ সম্পন্ন হিসেবে চিহ্নিত হয়েছে'); }
}
function archiveKaj(id) {
  const idx = DB.kaj.findIndex(i => i.id == id);
  if (idx === -1) return;
  const [item] = DB.kaj.splice(idx, 1);
  item.archivedAt = Date.now();
  DB.archive.kaj.unshift(item);
  markDeleted('kaj', id);
  saveDB(); renderAll(); pushNow(); showToast('🗄️ আর্কাইভে সরানো হয়েছে');
}

function renderKaj() {
  const list = document.getElementById('kaj-list');
  let items = DB.kaj;
  if (kajFilter === 'pending') items = items.filter(i => !i.done);
  if (kajFilter === 'done') items = items.filter(i => i.done);
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">কোনো কাজ নেই</div></div>`;
    return;
  }
  list.innerHTML = items.map(i => `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${esc(i.title)}</div>
          <div class="card-meta">${formatDate(i.date)}</div>
        </div>
        <span class="status-badge ${i.done ? 'ok' : 'pending'}">${i.done ? 'সম্পন্ন' : 'বাকি'}</span>
      </div>
      ${i.detail ? `<div class="card-body-row"><div class="item" style="width:100%">${esc(i.detail)}</div></div>` : ''}
      ${i.status ? `<div class="card-body-row"><div class="item">অবস্থা: <b>${esc(i.status)}</b></div></div>` : ''}
      ${i.reminder ? `<div class="card-body-row">${reminderBadgeHTML(i.reminder)}</div>` : ''}
      <div class="card-actions">
        <button class="btn-ghost" onclick="openKajModal(${i.id})">✏️ সম্পাদনা</button>
        ${!i.done ? `<button class="btn-success" onclick="markKajDone(${i.id})">✓ সম্পন্ন</button>` : ''}
        <button class="btn-danger" onclick="archiveKaj(${i.id})">🗄️ আর্কাইভ</button>
      </div>
    </div>
  `).join('');
}

// ══════════════════════════════════════════
//  NOTES
// ══════════════════════════════════════════
function openNoteModal(id) {
  document.getElementById('note-modal-title').textContent = id ? 'নোট সম্পাদনা' : 'নতুন নোট';
  document.getElementById('note-id').value = id || '';
  if (id) {
    const item = DB.notes.find(i => i.id == id);
    document.getElementById('note-title').value = item.title || '';
    document.getElementById('note-body').value = item.body || '';
    setReminderInput('note', item.reminder);
  } else {
    document.getElementById('note-title').value = '';
    document.getElementById('note-body').value = '';
    setReminderInput('note', '');
  }
  openModalEl('note-modal');
}

function saveNote() {
  const id = document.getElementById('note-id').value;
  const title = document.getElementById('note-title').value.trim();
  if (!title) { showToast('শিরোনাম লিখুন', 'error'); return; }
  const data = {
    title,
    body: document.getElementById('note-body').value.trim(),
    date: todayISO(),
    reminder: getReminderInput('note'),
  };
  if (id) {
    const item = DB.notes.find(i => i.id == id);
    const reminderChanged = (item.reminder || '') !== (data.reminder || '');
    Object.assign(item, data, { date: item.date });
    if (reminderChanged) item.reminderSent = false;
  } else {
    DB.notes.unshift({ id: uid(), reminderSent: false, ...data });
  }
  saveDB(); renderAll(); closeModal('note-modal');
  showToast('✅ নোট সংরক্ষিত হয়েছে');
}

function deleteNote(id) {
  if (!confirm('নোটটি মুছে ফেলতে চান?')) return;
  DB.notes = DB.notes.filter(i => i.id != id);
  markDeleted('notes', id); // বাগ ফিক্স: tombstone রাখা হচ্ছে যাতে sync এর সময় আবার ফিরে না আসে
  saveDB(); renderAll(); pushNow();
  showToast('নোট মুছে ফেলা হয়েছে');
}

function renderNotes() {
  const list = document.getElementById('notes-list');
  if (!DB.notes.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🗒️</div><div class="empty-text">কোনো নোট নেই</div></div>`;
    return;
  }
  list.innerHTML = DB.notes.map(i => `
    <div class="card">
      <div class="card-header">
        <div class="card-title">${esc(i.title)}</div>
        <span class="card-meta">${formatDate(i.date)}</span>
      </div>
      ${i.body ? `<div class="card-body-row"><div class="item" style="width:100%">${esc(i.body).replace(/\n/g,'<br>')}</div></div>` : ''}
      ${i.reminder ? `<div class="card-body-row">${reminderBadgeHTML(i.reminder)}</div>` : ''}
      <div class="card-actions">
        <button class="btn-ghost" onclick="openNoteModal(${i.id})">✏️ সম্পাদনা</button>
        <button class="btn-danger" onclick="deleteNote(${i.id})">🗑️ মুছুন</button>
      </div>
    </div>
  `).join('');
}

// ══════════════════════════════════════════
//  DIARY
// ══════════════════════════════════════════
function openDiaryModal(id) {
  document.getElementById('diary-modal-title').textContent = id ? 'ডায়েরি সম্পাদনা' : 'নতুন ডায়েরি লেখা';
  document.getElementById('diary-id').value = id || '';
  if (id) {
    const item = DB.diary.find(i => i.id == id);
    document.getElementById('diary-date').value = item.date || '';
    document.getElementById('diary-text').value = item.text || '';
  } else {
    document.getElementById('diary-date').value = todayISO();
    document.getElementById('diary-text').value = '';
  }
  openModalEl('diary-modal');
}

function saveDiary() {
  const id = document.getElementById('diary-id').value;
  const text = document.getElementById('diary-text').value.trim();
  if (!text) { showToast('কিছু লিখুন', 'error'); return; }
  const data = {
    date: document.getElementById('diary-date').value || todayISO(),
    text,
  };
  if (id) {
    const item = DB.diary.find(i => i.id == id);
    Object.assign(item, data);
  } else {
    DB.diary.unshift({ id: uid(), ...data });
  }
  saveDB(); renderAll(); closeModal('diary-modal');
  showToast('✅ ডায়েরি সংরক্ষিত হয়েছে');
}

function deleteDiary(id) {
  if (!confirm('এই লেখাটি মুছে ফেলতে চান?')) return;
  DB.diary = DB.diary.filter(i => i.id != id);
  markDeleted('diary', id); // বাগ ফিক্স: tombstone রাখা হচ্ছে যাতে sync এর সময় আবার ফিরে না আসে
  saveDB(); renderAll(); pushNow();
  showToast('ডায়েরি মুছে ফেলা হয়েছে');
}

function renderDiary() {
  const list = document.getElementById('diary-list');
  if (!DB.diary.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📔</div><div class="empty-text">কোনো লেখা নেই</div></div>`;
    return;
  }
  list.innerHTML = DB.diary.map(i => `
    <div class="card">
      <div class="card-header">
        <span class="status-badge info">${formatDate(i.date)}</span>
      </div>
      <div class="card-body-row"><div class="item" style="width:100%">${esc(i.text).replace(/\n/g,'<br>')}</div></div>
      <div class="card-actions">
        <button class="btn-ghost" onclick="openDiaryModal(${i.id})">✏️ সম্পাদনা</button>
        <button class="btn-danger" onclick="deleteDiary(${i.id})">🗑️ মুছুন</button>
      </div>
    </div>
  `).join('');
}

// ══════════════════════════════════════════
//  PAID WORK
// ══════════════════════════════════════════
let paidTypeFilter = 'all';
let paidStatusFilter = 'all';
function filterPaidType(f, btn) {
  paidTypeFilter = f;
  btn.parentElement.querySelectorAll('.subtab').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  renderPaid();
}
function filterPaidStatus(f, btn) {
  paidStatusFilter = f;
  btn.parentElement.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  renderPaid();
}

const paidTypeLabel = { 'haat-bazar': 'হাট-বাজার', 'vp': 'ভিপি', 'other': 'অন্যান্য' };

function openPaidModal(id) {
  document.getElementById('paid-modal-title').textContent = id ? 'পেইড ওয়ার্ক সম্পাদনা' : 'পেইড ওয়ার্ক — নতুন কাজ';
  document.getElementById('paid-id').value = id || '';
  if (id) {
    const item = DB.paid.find(i => i.id == id);
    document.getElementById('paid-type').value = item.type || 'haat-bazar';
    document.getElementById('paid-name').value = item.name || '';
    document.getElementById('paid-amount').value = item.amount || '';
    document.getElementById('paid-due').value = item.due || '';
    document.getElementById('paid-date').value = item.date || '';
    document.getElementById('paid-detail').value = item.detail || '';
    document.getElementById('paid-progress').value = item.progress || '';
    setReminderInput('paid', item.reminder);
  } else {
    document.getElementById('paid-type').value = 'haat-bazar';
    document.getElementById('paid-name').value = '';
    document.getElementById('paid-amount').value = '';
    document.getElementById('paid-due').value = '';
    document.getElementById('paid-date').value = todayISO();
    document.getElementById('paid-detail').value = '';
    document.getElementById('paid-progress').value = '';
    setReminderInput('paid', '');
  }
  openModalEl('paid-modal');
}

function savePaid() {
  const id = document.getElementById('paid-id').value;
  const name = document.getElementById('paid-name').value.trim();
  if (!name) { showToast('আবেদনকারীর নাম লিখুন', 'error'); return; }
  const data = {
    type: document.getElementById('paid-type').value,
    name,
    amount: Number(document.getElementById('paid-amount').value) || 0,
    due: Number(document.getElementById('paid-due').value) || 0,
    date: document.getElementById('paid-date').value || todayISO(),
    detail: document.getElementById('paid-detail').value.trim(),
    progress: document.getElementById('paid-progress').value.trim(),
    reminder: getReminderInput('paid'),
  };
  if (id) {
    const item = DB.paid.find(i => i.id == id);
    applyWithReminderReset(item, data);
  } else {
    DB.paid.unshift({ id: uid(), done: false, reminderSent: false, ...data });
  }
  saveDB(); renderAll(); closeModal('paid-modal');
  showToast('✅ পেইড ওয়ার্ক সংরক্ষিত হয়েছে');
}

function markPaidDone(id) {
  const idx = DB.paid.findIndex(i => i.id == id);
  if (idx === -1) return;
  const [item] = DB.paid.splice(idx, 1);
  item.done = true;
  item.archivedAt = Date.now();
  DB.archive.paid.unshift(item);
  markDeleted('paid', id);
  saveDB(); renderAll(); pushNow();
  showToast('✅ সম্পন্ন হয়ে আর্কাইভে সরানো হয়েছে');
}
function archivePaid(id) {
  const idx = DB.paid.findIndex(i => i.id == id);
  if (idx === -1) return;
  const [item] = DB.paid.splice(idx, 1);
  item.archivedAt = Date.now();
  DB.archive.paid.unshift(item);
  markDeleted('paid', id);
  saveDB(); renderAll(); pushNow(); showToast('🗄️ আর্কাইভে সরানো হয়েছে');
}

function renderPaid() {
  const list = document.getElementById('paid-list');
  let items = DB.paid;
  if (paidTypeFilter !== 'all') items = items.filter(i => i.type === paidTypeFilter);
  if (paidStatusFilter === 'pending') items = items.filter(i => !i.done);
  if (paidStatusFilter === 'done') items = items.filter(i => i.done);
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">💵</div><div class="empty-text">কোনো এন্ট্রি নেই</div></div>`;
  } else {
    list.innerHTML = items.map(i => `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${esc(i.name)}</div>
            <div class="card-meta">${paidTypeLabel[i.type] || i.type} · ${formatDate(i.date)}</div>
          </div>
          <span class="status-badge ${i.done ? 'ok' : 'pending'}">${i.done ? 'সম্পন্ন' : 'চলমান'}</span>
        </div>
        <div class="card-body-row">
          <div class="item">টাকা: <b>${money(i.amount)}</b></div>
          <div class="item">বকেয়া: <b>${money(i.due)}</b></div>
        </div>
        ${i.detail ? `<div class="card-body-row"><div class="item" style="width:100%">বিবরণ: ${esc(i.detail)}</div></div>` : ''}
        ${i.progress ? `<div class="card-body-row"><div class="item" style="width:100%">অগ্রগতি: ${esc(i.progress)}</div></div>` : ''}
        ${i.reminder ? `<div class="card-body-row">${reminderBadgeHTML(i.reminder)}</div>` : ''}
        <div class="card-actions">
          <button class="btn-ghost" onclick="openPaidModal(${i.id})">✏️ সম্পাদনা</button>
          ${!i.done ? `<button class="btn-success" onclick="markPaidDone(${i.id})">✓ সম্পন্ন</button>` : ''}
          <button class="btn-danger" onclick="archivePaid(${i.id})">🗄️ আর্কাইভ</button>
        </div>
      </div>
    `).join('');
  }
}

// ══════════════════════════════════════════
//  MUTATION
// ══════════════════════════════════════════
let mutationFilter = 'all';
function filterMutation(f, btn) {
  mutationFilter = f;
  document.querySelectorAll('#more-mutation .filter-chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  renderMutation();
}

function openMutationModal(id) {
  document.getElementById('mutation-modal-title').textContent = id ? 'মিউটেশন সম্পাদনা' : 'মিউটেশন — নতুন এন্ট্রি';
  document.getElementById('mutation-id').value = id || '';
  if (id) {
    const item = DB.mutation.find(i => i.id == id);
    document.getElementById('mutation-name').value = item.name || '';
    document.getElementById('mutation-case').value = item.case || '';
    document.getElementById('mutation-amount').value = item.amount || '';
    document.getElementById('mutation-due').value = item.due || '';
    document.getElementById('mutation-note').value = item.note || '';
    setReminderInput('mutation', item.reminder);
  } else {
    document.getElementById('mutation-name').value = '';
    document.getElementById('mutation-case').value = '';
    document.getElementById('mutation-amount').value = '';
    document.getElementById('mutation-due').value = '';
    document.getElementById('mutation-note').value = '';
    setReminderInput('mutation', '');
  }
  openModalEl('mutation-modal');
}

function saveMutation() {
  const id = document.getElementById('mutation-id').value;
  const name = document.getElementById('mutation-name').value.trim();
  if (!name) { showToast('আবেদনকারীর নাম লিখুন', 'error'); return; }
  const data = {
    name,
    case: document.getElementById('mutation-case').value.trim(),
    amount: Number(document.getElementById('mutation-amount').value) || 0,
    due: Number(document.getElementById('mutation-due').value) || 0,
    note: document.getElementById('mutation-note').value.trim(),
    date: todayISO(),
    reminder: getReminderInput('mutation'),
  };
  if (id) {
    const item = DB.mutation.find(i => i.id == id);
    const reminderChanged = (item.reminder || '') !== (data.reminder || '');
    Object.assign(item, data, { date: item.date });
    if (reminderChanged) item.reminderSent = false;
  } else {
    DB.mutation.unshift({ id: uid(), done: false, reminderSent: false, ...data });
  }
  saveDB(); renderAll(); closeModal('mutation-modal');
  showToast('✅ মিউটেশন এন্ট্রি সংরক্ষিত হয়েছে');
}

function markMutationDone(id) {
  const idx = DB.mutation.findIndex(i => i.id == id);
  if (idx === -1) return;
  const [item] = DB.mutation.splice(idx, 1);
  item.done = true;
  item.archivedAt = Date.now();
  DB.archive.mutation.unshift(item);
  markDeleted('mutation', id);
  saveDB(); renderAll(); pushNow();
  showToast('✅ সম্পন্ন হয়ে আর্কাইভে সরানো হয়েছে');
}
function archiveMutation(id) {
  const idx = DB.mutation.findIndex(i => i.id == id);
  if (idx === -1) return;
  const [item] = DB.mutation.splice(idx, 1);
  item.archivedAt = Date.now();
  DB.archive.mutation.unshift(item);
  markDeleted('mutation', id);
  saveDB(); renderAll(); pushNow(); showToast('🗄️ আর্কাইভে সরানো হয়েছে');
}

function renderMutation() {
  const list = document.getElementById('mutation-list');
  let items = DB.mutation;
  if (mutationFilter === 'pending') items = items.filter(i => !i.done);
  if (mutationFilter === 'done') items = items.filter(i => i.done);
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📑</div><div class="empty-text">কোনো এন্ট্রি নেই</div></div>`;
    return;
  }
  list.innerHTML = items.map(i => `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${esc(i.name)}</div>
          <div class="card-meta">কেস: ${esc(i.case) || '—'}</div>
        </div>
        <span class="status-badge ${i.done ? 'ok' : 'pending'}">${i.done ? 'সম্পন্ন' : 'চলমান'}</span>
      </div>
      <div class="card-body-row">
        <div class="item">টাকা: <b>${money(i.amount)}</b></div>
        <div class="item">বকেয়া: <b>${money(i.due)}</b></div>
      </div>
      ${i.note ? `<div class="card-body-row"><div class="item" style="width:100%">নোট: ${esc(i.note)}</div></div>` : ''}
      ${i.reminder ? `<div class="card-body-row">${reminderBadgeHTML(i.reminder)}</div>` : ''}
      <div class="card-actions">
        <button class="btn-ghost" onclick="openMutationModal(${i.id})">✏️ সম্পাদনা</button>
        ${!i.done ? `<button class="btn-success" onclick="markMutationDone(${i.id})">✓ সম্পন্ন</button>` : ''}
        <button class="btn-danger" onclick="archiveMutation(${i.id})">🗄️ আর্কাইভ</button>
      </div>
    </div>
  `).join('');
}

// ══════════════════════════════════════════
//  ARCHIVE
// ══════════════════════════════════════════
let archiveFilter = 'all';
function filterArchive(f, btn) {
  archiveFilter = f;
  document.querySelectorAll('#archive-filter-row .subtab').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  renderArchive();
}

function restoreArchive(type, id) {
  const idx = DB.archive[type].findIndex(i => i.id == id);
  if (idx === -1) return;
  const [item] = DB.archive[type].splice(idx, 1);
  delete item.archivedAt;
  const targetMap = { haat: 'haat', vp: 'vp', chithi: 'chithi', kaj: 'kaj', paid: 'paid', mutation: 'mutation' };
  DB[targetMap[type]].unshift(item);
  if (DB.deleted[type]) delete DB.deleted[type][id]; // active তে ফিরিয়ে আনা হলো — tombstone তুলে নেওয়া হলো যাতে sync এ আবার আসতে পারে
  saveDB(); renderAll(); pushNow();
  showToast('↩️ পুনরুদ্ধার করা হয়েছে');
}

function permanentDeleteArchive(type, id) {
  if (!confirm('এটি স্থায়ীভাবে মুছে যাবে। আপনি কি নিশ্চিত?')) return;
  DB.archive[type] = DB.archive[type].filter(i => i.id != id);
  markPurged(type, id); // স্থায়ী মুছে ফেলা — purged tombstone, যাতে sync এ active list ও archive কোথাও আবার না আসে
  saveDB(); renderAll(); pushNow();
  showToast('🗑️ স্থায়ীভাবে মুছে ফেলা হয়েছে');
}

const archiveTypeLabel = { haat: 'হাট-বাজার', vp: 'ভিপি', chithi: 'চিঠিপত্র', kaj: 'কাজ', paid: 'পেইড ওয়ার্ক', mutation: 'মিউটেশন' };

function archiveCardHTML(type, i) {
  let title = i.name || i.title || i.subject || 'এন্ট্রি';
  let metaParts = [];
  if (i.case) metaParts.push('কেস: ' + esc(i.case));
  if (i.haatName) metaParts.push('হাট: ' + esc(i.haatName));
  if (i.mouza) metaParts.push('মৌজা: ' + esc(i.mouza));
  if (i.total != null) metaParts.push('টাকা: ' + money(i.total));
  if (i.amount != null) metaParts.push('টাকা: ' + money(i.amount));
  if (i.due != null) metaParts.push('বকেয়া: ' + money(i.due));
  return `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${esc(title)}</div>
          <div class="card-meta">${archiveTypeLabel[type]} ${metaParts.length ? '· ' + metaParts.join(' · ') : ''}</div>
        </div>
        <span class="status-badge info">🗄️ আর্কাইভ</span>
      </div>
      <div class="card-actions">
        <button class="btn-success" onclick="restoreArchive('${type}',${i.id})">↩️ পুনরুদ্ধার</button>
        <button class="btn-danger" onclick="permanentDeleteArchive('${type}',${i.id})">🗑️ স্থায়ী মুছুন</button>
      </div>
    </div>
  `;
}

function renderArchive() {
  const list = document.getElementById('archive-list');
  let types = archiveFilter === 'all' ? Object.keys(DB.archive) : [archiveFilter];
  let html = '';
  let total = 0;
  types.forEach(type => {
    (DB.archive[type] || []).forEach(i => { html += archiveCardHTML(type, i); total++; });
  });
  if (!total) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🗄️</div><div class="empty-text">আর্কাইভ খালি আছে</div></div>`;
  } else {
    list.innerHTML = html;
  }
}

// ══════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════
// সব সেকশন থেকে রিমাইন্ডার-যুক্ত (এখনও পাঠানো হয়নি এমন না — সব রিমাইন্ডারই) এন্ট্রি একসাথে জোগাড় করে,
// ওভারডিউ আগে, তারপর সময় অনুযায়ী সাজিয়ে রিটার্ন করে — ড্যাশবোর্ডে দেখানোর জন্য
function getAllReminders() {
  const sources = [
    { type: 'haat', label: 'হাট-বাজার', icon: '🛒', tab: 'haat', items: DB.haat, titleKey: 'name' },
    { type: 'vp', label: 'ভিপি', icon: '🗺️', tab: 'vp', items: DB.vp, titleKey: 'name' },
    { type: 'chithi', label: 'চিঠিপত্র', icon: '✉️', tab: 'chithi', items: DB.chithi, titleKey: 'subject' },
    { type: 'kaj', label: 'কাজ', icon: '✅', tab: 'kaj', items: DB.kaj, titleKey: 'title' },
    { type: 'notes', label: 'নোট', icon: '🗒️', tab: 'diary', items: DB.notes, titleKey: 'title' },
    { type: 'paid', label: 'পেইড ওয়ার্ক', icon: '💵', tab: 'more', items: DB.paid, titleKey: 'name' },
    { type: 'mutation', label: 'মিউটেশন', icon: '📑', tab: 'more', items: DB.mutation, titleKey: 'name' },
  ];
  const out = [];
  for (const src of sources) {
    for (const item of (src.items || [])) {
      if (!item.reminder) continue;
      const status = reminderStatus(item.reminder);
      if (!status) continue;
      out.push({
        id: item.id, type: src.type, tab: src.tab, icon: src.icon, label: src.label,
        title: item[src.titleKey] || '(শিরোনামহীন)', reminder: item.reminder, status
      });
    }
  }
  out.sort((a, b) => new Date(a.reminder) - new Date(b.reminder));
  return out;
}

// ড্যাশবোর্ডের রিমাইন্ডার লিস্টে ক্লিক করলে সংশ্লিষ্ট ট্যাবে নিয়ে যাবে
function goToReminderItem(tab, type) {
  if (type === 'paid') { openMoreSubtab('paid'); return; }
  if (type === 'mutation') { openMoreSubtab('mutation'); return; }
  showTab(tab);
  if (type === 'notes') showDiarySub('note');
}

function renderDashboard() {
  document.getElementById('dash-haat-count').textContent = DB.haat.filter(i=>i.status!=='done').length;
  document.getElementById('dash-vp-count').textContent = DB.vp.filter(i=>i.status!=='done').length;
  document.getElementById('dash-kaj-count').textContent = DB.kaj.filter(i=>!i.done).length;
  document.getElementById('dash-chithi-count').textContent = DB.chithi.length;
  document.getElementById('dash-paid-count').textContent = DB.paid.filter(i=>!i.done).length;
  document.getElementById('dash-mutation-count').textContent = DB.mutation.filter(i=>!i.done).length;

  const totalJoma = DB.haat.reduce((s,i)=>s+i.total,0) + DB.vp.reduce((s,i)=>s+i.total,0);
  const totalBokeya = DB.haat.reduce((s,i)=>s+i.due,0) + DB.vp.reduce((s,i)=>s+i.due,0);
  document.getElementById('dash-total-joma').textContent = money(totalJoma);
  document.getElementById('dash-total-bokeya').textContent = money(totalBokeya);
  document.getElementById('dash-total-mot').textContent = money(totalJoma + totalBokeya);

  // 🔔 রিমাইন্ডার কার্ড — ওভারডিউ ও আজকের/আসন্ন রিমাইন্ডার থাকলে দেখাবে, না থাকলে কার্ড লুকানো থাকবে
  const reminders = getAllReminders();
  const remCard = document.getElementById('dash-reminders-card');
  const remList = document.getElementById('dash-reminders-list');
  if (!reminders.length) {
    remCard.style.display = 'none';
  } else {
    remCard.style.display = 'block';
    remList.innerHTML = reminders.map(r => `
      <div class="reminder-item" style="cursor:pointer" onclick="goToReminderItem('${r.tab}','${r.type}')">
        <div>
          <div class="r-title">${r.icon} ${esc(r.title)}</div>
          <div class="r-meta">${esc(r.label)} · ${esc(reminderLabel(r.reminder))}</div>
        </div>
        <span class="reminder-pill ${r.status === 'overdue' ? 'overdue' : r.status === 'today' ? 'today' : 'upcoming'}">
          ${r.status === 'overdue' ? 'মিস হয়েছে' : r.status === 'today' ? 'আজ/২৪ ঘ.' : 'আসছে'}
        </span>
      </div>
    `).join('');
  }

  const recent = DB.kaj.filter(i=>!i.done).slice(0, 5);
  const recentBox = document.getElementById('dash-recent-tasks');
  if (!recent.length) {
    recentBox.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:10px 0">কোনো পেন্ডিং কাজ নেই 🎉</div>`;
  } else {
    recentBox.innerHTML = recent.map(i => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-size:14px;font-weight:500">${esc(i.title)}</div>
          ${i.status ? `<div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(i.status)}</div>` : ''}
        </div>
        <span class="card-meta">${formatDate(i.date)}</span>
      </div>
    `).join('');
  }
}


// ══════════════════════════════════════════
//  RENDER ALL
// ══════════════════════════════════════════
function renderAll() {
  renderDashboard();
  renderHaat();
  renderVp();
  renderChithi();
  renderKaj();
  renderNotes();
  renderDiary();
  renderPaid();
  renderMutation();
  renderArchive();
}

// ══════════════════════════════════════════
//  FIREBASE — personal vault এর প্রজেক্টের আলাদা path (office/data) এ sync হয়
// ══════════════════════════════════════════
async function initFirebase(cfg) {
  try {
    const { initializeApp, getApps } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    const { getDatabase, ref, set, get, onValue } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js');
    const existing = getApps();
    fbApp = existing.length ? existing[0] : initializeApp(cfg);
    fbDb = getDatabase(fbApp);
    window._fbRef = ref;
    window._fbSet = set;
    window._fbGet = get;
    window._fbOnValue = onValue;
    return true;
  } catch (e) {
    console.error('Firebase init error:', e);
    return false;
  }
}

async function connectFirebase() {
  const cfg = {
    apiKey:      document.getElementById('fb-apikey').value.trim(),
    authDomain:  document.getElementById('fb-authdomain').value.trim(),
    databaseURL: document.getElementById('fb-dburl').value.trim(),
    projectId:   document.getElementById('fb-projectid').value.trim(),
  };
  if (!cfg.apiKey || !cfg.databaseURL || !cfg.projectId) {
    showToast('সব তথ্য পূরণ করুন', 'error'); return;
  }
  document.getElementById('fb-status').innerHTML = '<span class="status-badge pending">⏳ সংযোগ হচ্ছে...</span>';
  const ok = await initFirebase(cfg);
  if (!ok) {
    document.getElementById('fb-status').innerHTML = '<span class="status-badge err">✗ ব্যর্থ</span>';
    showToast('Firebase সংযোগ ব্যর্থ — তথ্য যাচাই করুন', 'error'); return;
  }
  try {
    await window._fbSet(window._fbRef(fbDb, FB_PATH + '/_ping'), Date.now());
  } catch (e) {
    document.getElementById('fb-status').innerHTML = '<span class="status-badge err">✗ লেখার অনুমতি নেই</span>';
    showToast('Firebase Rules চেক করুন (.write: true আছে কিনা)', 'error'); return;
  }
  DB.settings.fbConfig = cfg;
  saveDB();
  showFbConnected();
  showToast('🔥 Firebase সংযুক্ত হয়েছে! এখন থেকে অটো-সিঙ্ক হবে');
  startFirebaseSync();
  await pullFromFirebase();
  await pushToFirebase();
}

function showFbConnected() {
  document.getElementById('fb-setup-view').style.display = 'none';
  document.getElementById('fb-connected-view').style.display = 'block';
  const pid = DB.settings?.fbConfig?.projectId || '';
  document.getElementById('fb-project-name').textContent = pid;
  setSyncStatus(true, 'Firebase ✓');
}

function disconnectFirebase() {
  if (!confirm('Firebase সংযোগ বিচ্ছিন্ন করবেন? এতে অন্য ডিভাইস/Telegram বট থেকে সিঙ্ক বন্ধ হয়ে যাবে।')) return;
  fbApp = null; fbDb = null;
  delete DB.settings.fbConfig;
  saveDB();
  document.getElementById('fb-setup-view').style.display = 'block';
  document.getElementById('fb-connected-view').style.display = 'none';
  setSyncStatus(false, 'লোকাল মোড');
  showToast('Firebase সংযোগ বিচ্ছিন্ন হয়েছে');
}

async function forceSyncFirebase() {
  if (!fbDb) { showToast('Firebase সংযুক্ত নেই', 'error'); return; }
  setSyncStatus(true, 'Sync হচ্ছে...');
  await pullFromFirebase();
  await pushToFirebase();
  setSyncStatus(true, 'Synced ✓');
  showToast('☁️ Firebase এ Sync সম্পন্ন');
}

// localArr ও remoteArr কে id অনুযায়ী merge করে — কোনো ডেটা হারাবে না, কিন্তু tombstone এ থাকা আইটেম আর ফিরবে না
function mergeById(localArr, remoteArr, deletedMap) {
  localArr = localArr || [];
  remoteArr = remoteArr || [];
  deletedMap = deletedMap || {};
  const map = new Map();
  for (const item of remoteArr) {
    if (deletedMap[item.id] != null || deletedMap[String(item.id)] != null) continue;
    map.set(String(item.id), item);
  }
  for (const item of localArr) {
    if (deletedMap[item.id] != null || deletedMap[String(item.id)] != null) continue;
    map.set(String(item.id), item); // local পরিবর্তন প্রাধান্য পাবে
  }
  return Array.from(map.values()).sort((a, b) => (b.id || 0) - (a.id || 0));
}

// সব merge logic এর পর শেষ ধাপে এটা চালানো হয় — tombstone এ থাকা যেকোনো id, যেখানেই থাকুক
// (active list বা archive), জোর করে বাদ দিয়ে দেয়। এটাই চূড়ান্ত নিরাপত্তা স্তর, merge ঠিকমতো
// কাজ করুক বা না করুক, এই ফাংশনের পর tombstone এর item আর কোথাও থাকতে পারবে না।
function purgeDeletedEverywhere() {
  for (const type of SYNC_TYPES) {
    const dmap = DB.deleted[type] || {};
    const pmap = DB.purged[type] || {};
    const deletedIds = new Set(Object.keys(dmap).map(String));
    const purgedIds = new Set(Object.keys(pmap).map(String));

    // active list থেকে বাদ: হয় আর্কাইভ করা হয়েছে (deleted), নয়তো স্থায়ীভাবে মুছে ফেলা হয়েছে (purged)
    if (deletedIds.size || purgedIds.size) {
      DB[type] = (DB[type] || []).filter(i => !deletedIds.has(String(i.id)) && !purgedIds.has(String(i.id)));
    }
    // archive থেকে বাদ: শুধুমাত্র স্থায়ীভাবে মুছে ফেলা হলে (purged) — আর্কাইভ করা item এখানেই থাকার কথা
    if (purgedIds.size) {
      DB.archive[type] = (DB.archive[type] || []).filter(i => !purgedIds.has(String(i.id)));
    }
  }
  // নোট ও ডায়েরির জন্য — এগুলোর archive নেই, সরাসরি ডিলিট হয়। তাই শুধু active list থেকে
  // tombstone এ থাকা id বাদ দেওয়া হয় (বাগ ফিক্স: আগে এই দুটো এই safety-net এর বাইরে ছিল)
  for (const type of SIMPLE_SYNC_TYPES) {
    const dmap = DB.deleted[type] || {};
    const deletedIds = new Set(Object.keys(dmap).map(String));
    if (deletedIds.size) {
      DB[type] = (DB[type] || []).filter(i => !deletedIds.has(String(i.id)));
    }
  }
}

const SYNC_TYPES = ['haat', 'vp', 'chithi', 'kaj', 'paid', 'mutation'];
// notes ও diary — archive সিস্টেমের বাইরে, সরাসরি ডিলিট হয়, কিন্তু এখন থেকে tombstone ব্যবহার করবে
// যাতে Firebase sync এর সময় ডিলিট করা আইটেম আবার ফিরে না আসে (বাগ ফিক্স)
const SIMPLE_SYNC_TYPES = ['notes', 'diary'];

// active list এর জন্য — deleted (archived) এবং purged (স্থায়ী মুছে ফেলা) দুটো মিলিয়ে একটা combined tombstone map দেয়
function combinedTombstone(type) {
  return { ...(DB.deleted[type] || {}), ...(DB.purged[type] || {}) };
}

// notes/diary এর জন্য — শুধু deleted tombstone (এদের purged/archive ধারণা নেই)
function simpleTombstone(type) {
  return { ...(DB.deleted[type] || {}) };
}

async function pushToFirebase() {
  if (!fbDb) return;
  try {
    // race-condition বাঁচাতে আগে remote থেকে merge করে নিচ্ছি (Telegram bot থেকে নতুন কিছু এসে থাকলে যেন হারিয়ে না যায়)
    try {
      const snap = await window._fbGet(window._fbRef(fbDb, FB_PATH));
      if (snap.exists()) {
        const remote = snap.val();
        if (remote.deleted) {
          for (const type of Object.keys(DB.deleted)) {
            DB.deleted[type] = { ...(remote.deleted[type] || {}), ...(DB.deleted[type] || {}) };
          }
        }
        if (remote.purged) {
          for (const type of Object.keys(DB.purged)) {
            DB.purged[type] = { ...(remote.purged[type] || {}), ...(DB.purged[type] || {}) };
          }
        }
        for (const type of SYNC_TYPES) {
          DB[type] = mergeById(DB[type], remote[type], combinedTombstone(type));
        }
        // বাগ ফিক্স: notes/diary এখন tombstone সম্মান করে merge হয়, যাতে ডিলিট করা এন্ট্রি ফিরে না আসে
        for (const type of SIMPLE_SYNC_TYPES) {
          DB[type] = mergeById(DB[type], remote[type], simpleTombstone(type));
        }
        if (remote.archive) {
          for (const type of SYNC_TYPES) {
            DB.archive[type] = mergeById(DB.archive[type], (remote.archive || {})[type], DB.purged[type]);
          }
        }
        purgeDeletedEverywhere(); // চূড়ান্ত নিরাপত্তা — tombstone এর কোনো item যেন কোথাও না থাকে
      }
    } catch (e) { /* remote read ব্যর্থ হলেও local দিয়ে এগিয়ে যাই */ }

    const stamp = Date.now();
    const payload = {
      haat: DB.haat, vp: DB.vp, chithi: DB.chithi, kaj: DB.kaj,
      paid: DB.paid, mutation: DB.mutation,
      notes: DB.notes, diary: DB.diary,
      archive: DB.archive,
      deleted: DB.deleted,
      purged: DB.purged,
      updatedAt: stamp
    };
    window._lastPushStamp = stamp; // এই push নিজে যা পাঠাচ্ছে, সেটা listener এ ফিরে এলে যেন আবার "নতুন" মনে না করে
    await window._fbSet(window._fbRef(fbDb, FB_PATH), payload);
    saveLocalOnly(); renderAll();
  } catch (e) {
    setSyncStatus(false, 'Sync ব্যর্থ');
    showToast('Firebase sync ব্যর্থ: ' + e.message, 'error');
  }
}

async function pullFromFirebase() {
  if (!fbDb) return;
  try {
    const snap = await window._fbGet(window._fbRef(fbDb, FB_PATH));
    if (snap.exists()) {
      const d = snap.val();
      if (d.deleted) {
        for (const type of Object.keys(DB.deleted)) {
          DB.deleted[type] = { ...(d.deleted[type] || {}), ...(DB.deleted[type] || {}) };
        }
      }
      if (d.purged) {
        for (const type of Object.keys(DB.purged)) {
          DB.purged[type] = { ...(d.purged[type] || {}), ...(DB.purged[type] || {}) };
        }
      }
      for (const type of SYNC_TYPES) {
        if (d[type]) DB[type] = mergeById(DB[type], d[type], combinedTombstone(type));
      }
      // বাগ ফিক্স: notes/diary এখন tombstone সম্মান করে merge হয়
      for (const type of SIMPLE_SYNC_TYPES) {
        if (d[type]) DB[type] = mergeById(DB[type], d[type], simpleTombstone(type));
      }
      if (d.archive) {
        for (const type of SYNC_TYPES) {
          DB.archive[type] = mergeById(DB.archive[type], (d.archive || {})[type], DB.purged[type]);
        }
      }
      purgeDeletedEverywhere(); // চূড়ান্ত নিরাপত্তা — tombstone এর কোনো item যেন কোথাও না থাকে
      saveLocalOnly(); renderAll();
      setSyncStatus(true, 'Synced ✓');
    }
  } catch (e) { console.warn('Firebase pull error:', e); }
}

function startFirebaseSync() {
  if (!fbDb) return;
  let isFirstSnapshot = true; // পেজ খোলার পর listener এর প্রথম reading — এটা নতুন event না, তাই notification দেখাবো না
  // Real-time listener — Telegram বট বা অন্য ডিভাইস থেকে কিছু যোগ হলে সাথে সাথে এখানেও দেখা যাবে
  window._fbOnValue(window._fbRef(fbDb, FB_PATH), (snap) => {
    if (!snap.exists()) { isFirstSnapshot = false; return; }
    const d = snap.val();
    if (!d.updatedAt) { isFirstSnapshot = false; return; }

    const firstLoad = isFirstSnapshot;
    isFirstSnapshot = false;

    // এই update টা নিজের পাঠানো push এর প্রতিধ্বনি কিনা চেক করি — হলে কিছুই করার দরকার নেই
    if (d.updatedAt === window._lastPushStamp) return;

    // ইতিমধ্যে দেখা/প্রসেস করা updatedAt হলে আবার প্রসেস করব না (Firebase মাঝে মাঝে একই ডেটা একাধিকবার পাঠাতে পারে)
    if (d.updatedAt === window._lastSeenRemoteStamp) return;
    window._lastSeenRemoteStamp = d.updatedAt;

    // প্রথমবার লোড না হলে, এবং নিজের সাম্প্রতিক local পরিবর্তনের চেয়ে পুরোনো হলে — স্কিপ করি
    if (!firstLoad && d.updatedAt <= (window._lastLocalUpdate || 0)) return;

    if (d.deleted) {
      for (const type of Object.keys(DB.deleted)) {
        DB.deleted[type] = { ...(d.deleted[type] || {}), ...(DB.deleted[type] || {}) };
      }
    }
    if (d.purged) {
      for (const type of Object.keys(DB.purged)) {
        DB.purged[type] = { ...(d.purged[type] || {}), ...(DB.purged[type] || {}) };
      }
    }
    for (const type of SYNC_TYPES) {
      if (d[type]) DB[type] = mergeById(DB[type], d[type], combinedTombstone(type));
    }
    // বাগ ফিক্স: notes/diary এখন tombstone সম্মান করে merge হয়
    for (const type of SIMPLE_SYNC_TYPES) {
      if (d[type]) DB[type] = mergeById(DB[type], d[type], simpleTombstone(type));
    }
    if (d.archive) {
      for (const type of SYNC_TYPES) {
        DB.archive[type] = mergeById(DB.archive[type], (d.archive || {})[type], DB.purged[type]);
      }
    }
    purgeDeletedEverywhere(); // চূড়ান্ত নিরাপত্তা — tombstone এর কোনো item যেন কোথাও না থাকে
    saveLocalOnly(); renderAll();
    setSyncStatus(true, firstLoad ? 'Synced ✓' : 'Real-time ✓');

    // প্রথমবার পেজ লোড হওয়ার সময়কার sync কে "নতুন আপডেট" হিসেবে দেখানো হবে না — এটা স্বাভাবিক প্রথম sync
    if (!firstLoad) {
      showToast('🔔 নতুন আপডেট এসেছে (Telegram/অন্য ডিভাইস থেকে)');
    }
  });
}

function setSyncStatus(ok, text) {
  const dot = document.getElementById('sync-dot');
  const txt = document.getElementById('sync-text');
  if (!dot || !txt) return;
  dot.className = 'sync-dot' + (ok ? '' : ' offline');
  txt.textContent = text;
}

// ══════════════════════════════════════════
//  TELEGRAM (অপশনাল — পরে সংযোগ করবেন)
// ══════════════════════════════════════════
function saveTelegram() {
  DB.settings.tgToken = document.getElementById('tg-token').value.trim();
  DB.settings.tgChatId = document.getElementById('tg-chat').value.trim();
  saveDB();
  document.getElementById('tg-status').innerHTML = '<span class="status-badge ok">✓ সংরক্ষিত</span>';
  showToast('✅ Telegram সেটিং সংরক্ষিত');
}

async function testTelegram() {
  const { tgToken, tgChatId } = DB.settings || {};
  if (!tgToken || !tgChatId) {
    document.getElementById('tg-status').innerHTML = '<span class="status-badge err">✗ টোকেন/চ্যাট আইডি নেই</span>';
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChatId, text: '🏢 ভূমি অফিস থেকে টেস্ট বার্তা! সংযোগ সফল হয়েছে ✅' })
    });
    if (res.ok) document.getElementById('tg-status').innerHTML = '<span class="status-badge ok">✓ কাজ করছে</span>';
    else document.getElementById('tg-status').innerHTML = '<span class="status-badge err">✗ ব্যর্থ</span>';
  } catch { document.getElementById('tg-status').innerHTML = '<span class="status-badge err">✗ ব্যর্থ</span>'; }
}

// ══════════════════════════════════════════
//  EXPORT / IMPORT
// ══════════════════════════════════════════
function exportData() {
  const blob = new Blob([JSON.stringify(DB, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `land-office-backup-${todayISO()}.json`;
  a.click();
  showToast('✅ ডেটা export হয়েছে');
}

function importData(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (confirm('Import করবেন? এতে বিদ্যমান ডেটা পরিবর্তিত হবে।')) {
        DB = {
          ...DB, ...data,
          archive: { ...DB.archive, ...(data.archive || {}) },
          deleted: { ...DB.deleted, ...(data.deleted || {}) },
          purged: { ...DB.purged, ...(data.purged || {}) }
        };
        purgeDeletedEverywhere();
        saveDB(); renderAll();
        showToast('✅ ডেটা import হয়েছে');
      }
    } catch { showToast('ফাইল পড়তে সমস্যা হয়েছে', 'error'); }
  };
  reader.readAsText(file);
}

// ══════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════

// একই ব্রাউজার ট্যাবে আগে থেকে আনলক করা থাকলে আবার পিন চাইবে না (ট্যাব বন্ধ করলে আবার চাইবে)
try {
  if (sessionStorage.getItem('land_office_unlocked') === '1') {
    document.getElementById('pin-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
  }
} catch {}

// Enter চাপলেই পিন submit হবে
document.getElementById('pin-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') checkPin();
});
document.getElementById('pin-input').focus();

loadDB();
renderAll();
if (DB.settings.tgToken) document.getElementById('tg-token').value = DB.settings.tgToken;
if (DB.settings.tgChatId) document.getElementById('tg-chat').value = DB.settings.tgChatId;

// আগে থেকে Firebase config সংরক্ষিত থাকলে অটো-কানেক্ট হবে — প্রতিবার পেজ খুললে নতুন করে কানেক্ট করতে হবে না
if (DB.settings.fbConfig) {
  const cfg = DB.settings.fbConfig;
  document.getElementById('fb-apikey').value = cfg.apiKey || '';
  document.getElementById('fb-authdomain').value = cfg.authDomain || '';
  document.getElementById('fb-dburl').value = cfg.databaseURL || '';
  document.getElementById('fb-projectid').value = cfg.projectId || '';
  initFirebase(cfg).then(ok => {
    if (ok) {
      showFbConnected();
      startFirebaseSync();
      pullFromFirebase();
    } else {
      setSyncStatus(false, 'Firebase সংযোগ ব্যর্থ');
    }
  });
} else {
  setSyncStatus(false, 'লোকাল মোড');
}


// ══════════════════════════════════════════
//  NEWS SECTION — সংবাদ ও নোটিশ
// ══════════════════════════════════════════

const NEWS_CACHE_KEY = 'land_office_news_cache_v2';
// দিনে ১ বার (সকালে Worker নিজেই Cron দিয়ে আপডেট করে) যথেষ্ট —
// তাই অ্যাপ নিজে থেকে ৬ ঘণ্টার বেশি পুরনো cache থাকলেই নতুন করে আনবে
const NEWS_CACHE_TTL = 6 * 60 * 60 * 1000; // ৬ ঘণ্টা
// ⚠️ Worker এর বেস URL (পাথ ছাড়া) — নিচে /news ও /refresh যুক্ত হবে automatic ভাবে
// আগে এখানে https:// ছিল না বলেই Worker থেকে কখনো real ডেটা আসছিল না — এটাই ঠিক করা হলো
const NEWS_WORKER_BASE = 'https://delicate-math-9f4c.officeuzzal135.workers.dev';
const NEWS_WORKER_URL = NEWS_WORKER_BASE + '/news';
const NEWS_REFRESH_URL = NEWS_WORKER_BASE + '/refresh';

let allNewsItems = [];
let currentNewsFilter = 'all';
let newsUsingFallback = false; // true হলে বোঝাবে Worker থেকে ডেটা আনা যায়নি, sample/static নিউজ দেখানো হচ্ছে

// সংবাদ উৎস — সরকারি ও প্রাসঙ্গিক ওয়েবসাইট
// (Worker (news-worker.js) এর SOURCES লিস্টের সাথে এই তালিকা মিলিয়ে রাখা হয়েছে)
const NEWS_SOURCES = [
  { id: 'land', label: 'ভূমি মন্ত্রণালয়', icon: '🏛️', badge: 'land', category: 'land', url: 'https://minland.gov.bd' },
  { id: 'dc', label: 'যশোর DC অফিস', icon: '🏢', badge: 'dc', category: 'dc', url: 'https://jessore.gov.bd' },
  { id: 'comm', label: 'খুলনা কমিশনার', icon: '🏛️', badge: 'comm', category: 'comm', url: 'https://khulnadiv.gov.bd' },
  { id: 'bpsc', label: 'BPSC — চাকরি', icon: '💼', badge: 'job', category: 'job', url: 'https://bpsc.gov.bd' },
  { id: 'land_record', label: 'ভূমি রেকর্ড অধিদফতর', icon: '📄', badge: 'land', category: 'land', url: 'https://dlrs.gov.bd' },
  { id: 'land_reform_board', label: 'ভূমি সংস্কার বোর্ড', icon: '🏛️', badge: 'land', category: 'land', url: 'https://lrb.gov.bd' },
  { id: 'gazette', label: 'বাংলাদেশ গেজেট', icon: '📜', badge: 'gazette', category: 'gazette', url: 'https://www.dpp.gov.bd/bgpress/' },
  { id: 'mopa', label: 'জনপ্রশাসন মন্ত্রণালয়', icon: '📋', badge: 'general', category: 'general', url: 'https://mopa.gov.bd' }
];

// গুরুত্বপূর্ণ কীওয়ার্ড — এগুলো থাকলে "জরুরি" ট্যাগ দেখাবে
const IMPORTANT_KEYWORDS = ['পরিপত্র', 'গেজেট', 'জরুরি', 'নোটিশ', 'সময়সীমা', 'তারিখ', 'আবেদন', 'নিয়োগ', 'ফলাফল', 'তালিকা', 'বিজ্ঞপ্তি', 'দরপত্র'];

// ────────────────────────────────────
// স্ট্যাটিক/নমুনা নিউজ ডেটা — Worker থেকে real ডেটা আনা সম্ভব না হলে
// (যেমন ইন্টারনেট সমস্যা বা Worker সাময়িক বন্ধ) এই নমুনা ডেটা দেখানো হয়,
// যাতে স্ক্রিন খালি না থাকে। এগুলোতে isFallback:true থাকে, যাতে UI তে
// স্পষ্ট লেখা থাকে এটা নমুনা, real না।
// ────────────────────────────────────
function getStaticNews() {
  const items = getStaticNewsRaw();
  return items.map(it => ({ ...it, isFallback: true }));
}

function getStaticNewsRaw() {
  const today = new Date();
  const fmt = (d) => d.toLocaleDateString('bn-BD', { day:'numeric', month:'long', year:'numeric' });
  const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate()-n); return d; };

  return [
    // ─── ভূমি মন্ত্রণালয় ───
    {
      id: 'land_001',
      category: 'land',
      title: 'ভূমি উন্নয়ন কর অনলাইনে পরিশোধের নতুন নির্দেশনা জারি',
      summary: 'ভূমি মন্ত্রণালয় ভূমি উন্নয়ন কর অনলাইনে পরিশোধের সংশোধিত নির্দেশিকা প্রকাশ করেছে। সকল ভূমি অফিসকে এই পদ্ধতি অনুসরণ করতে বলা হয়েছে।',
      date: daysAgo(1),
      source: 'ভূমি মন্ত্রণালয়',
      url: 'https://minland.gov.bd/site/page/9d6a4c58-c2ae-41a7-9e41-1f9e3f4d4271',
      isNew: true,
      important: true
    },
    {
      id: 'land_002',
      category: 'land',
      title: 'নামজারি (মিউটেশন) আবেদন নিষ্পত্তির সময়সীমা হ্রাস — নতুন পরিপত্র',
      summary: 'ভূমি মন্ত্রণালয় নামজারি আবেদন সর্বোচ্চ ৪৫ কার্যদিবসে নিষ্পত্তির নির্দেশ দিয়েছে। ব্যর্থ হলে সংশ্লিষ্ট কর্মকর্তার বিরুদ্ধে ব্যবস্থা নেওয়া হবে।',
      date: daysAgo(3),
      source: 'ভূমি মন্ত্রণালয়',
      url: 'https://minland.gov.bd/site/notices',
      isNew: false,
      important: true
    },
    {
      id: 'land_003',
      category: 'land',
      title: 'ডিজিটাল ভূমি ব্যবস্থাপনা সিস্টেম আপগ্রেড — সার্ভিস সাময়িক বন্ধ',
      summary: 'ই-নামজারি ও ভূমি রেকর্ড পোর্টালের রক্ষণাবেক্ষণ কাজ চলবে। এই সময়ে অনলাইনে আবেদন ও দাখিলা যাচাই সাময়িকভাবে বন্ধ থাকবে।',
      date: daysAgo(5),
      source: 'ভূমি মন্ত্রণালয়',
      url: 'https://land.gov.bd',
      isNew: false,
      important: false
    },
    {
      id: 'land_004',
      category: 'land',
      title: 'ভূমি সেবা সপ্তাহ ২০২৬ — সেবা গ্রহণে জনগণকে উৎসাহিত করার নির্দেশ',
      summary: 'সারা দেশে ভূমি সেবা সপ্তাহ পালনের নির্দেশ দিয়েছে মন্ত্রণালয়। সকল ভূমি অফিসকে বিশেষ সেবা ক্যাম্প পরিচালনা করতে বলা হয়েছে।',
      date: daysAgo(7),
      source: 'ভূমি মন্ত্রণালয়',
      url: 'https://minland.gov.bd/site/notices',
      isNew: false,
      important: false
    },
    // ─── যশোর DC অফিস ───
    {
      id: 'dc_001',
      category: 'dc',
      title: 'যশোর জেলা প্রশাসক কার্যালয়ে নতুন সেবা উদ্বোধন',
      summary: 'যশোর ডিসি অফিসে ই-সেবা কেন্দ্রের মাধ্যমে নতুন জনবান্ধব সেবা চালু করা হয়েছে। সনদ ও প্রত্যয়নপত্র এখন অনলাইনে পাওয়া যাবে।',
      date: daysAgo(2),
      source: 'যশোর DC অফিস',
      url: 'https://jessore.gov.bd/site/notices',
      isNew: true,
      important: false
    },
    {
      id: 'dc_002',
      category: 'dc',
      title: 'যশোর জেলায় হাট-বাজার ইজারা নবায়নের সময়সূচি প্রকাশ',
      summary: 'যশোর জেলার সকল সরকারি হাট-বাজারের বার্ষিক ইজারা নবায়নের তারিখ ও প্রক্রিয়া প্রকাশিত হয়েছে। সংশ্লিষ্ট ব্যবসায়ীদের নির্ধারিত সময়ে আবেদন করতে বলা হয়েছে।',
      date: daysAgo(4),
      source: 'যশোর DC অফিস',
      url: 'https://jessore.gov.bd',
      isNew: false,
      important: true
    },
    {
      id: 'dc_003',
      category: 'dc',
      title: 'যশোর জেলা উন্নয়ন সমন্বয় কমিটির সভার কার্যবিবরণী',
      summary: 'মাসিক উন্নয়ন সমন্বয় সভায় জেলার অগ্রাধিকার প্রকল্পগুলোর অগ্রগতি পর্যালোচনা করা হয়েছে। ভূমি অধিগ্রহণ প্রকল্পেও আলোচনা হয়েছে।',
      date: daysAgo(6),
      source: 'যশোর DC অফিস',
      url: 'https://jessore.gov.bd/site/notices',
      isNew: false,
      important: false
    },
    {
      id: 'dc_004',
      category: 'dc',
      title: 'যশোরে ভূমি অপরাধ প্রতিরোধে জেলা টাস্কফোর্সের বৈঠক',
      summary: 'অবৈধ দখল ও ভূমি জালিয়াতি রোধে জেলা প্রশাসনের বিশেষ টাস্কফোর্স সক্রিয় করা হয়েছে। সন্দেহজনক বিষয় সরাসরি DC অফিসে জানানোর আহ্বান।',
      date: daysAgo(8),
      source: 'যশোর DC অফিস',
      url: 'https://jessore.gov.bd',
      isNew: false,
      important: false
    },
    // ─── খুলনা বিভাগীয় কমিশনার ───
    {
      id: 'comm_001',
      category: 'comm',
      title: 'খুলনা বিভাগের ভূমি অফিসগুলোতে বিশেষ পরিদর্শন — কমিশনারের নির্দেশ',
      summary: 'বিভাগীয় কমিশনার খুলনা বিভাগের সকল সাব-রেজিস্ট্রি ও ভূমি অফিস পরিদর্শনের নির্দেশ দিয়েছেন। সেবার মান উন্নয়নে কঠোর নজরদারি চলবে।',
      date: daysAgo(2),
      source: 'খুলনা বিভাগীয় কমিশনার',
      url: 'https://khulnadiv.gov.bd/site/notices',
      isNew: true,
      important: true
    },
    {
      id: 'comm_002',
      category: 'comm',
      title: 'খুলনা বিভাগীয় ভূমি রাজস্ব সম্মেলন — সকল জেলা প্রশাসককে নির্দেশ',
      summary: 'বিভাগীয় ভূমি রাজস্ব সম্মেলনে যশোরসহ সকল জেলার কর্মকর্তাদের অংশগ্রহণ বাধ্যতামূলক করা হয়েছে। আদায়ের লক্ষ্যমাত্রা নির্ধারণ করা হবে।',
      date: daysAgo(5),
      source: 'খুলনা বিভাগীয় কমিশনার',
      url: 'https://khulnadiv.gov.bd',
      isNew: false,
      important: false
    },
    {
      id: 'comm_003',
      category: 'comm',
      title: 'খুলনা বিভাগের জলাভূমি সংরক্ষণে নতুন নীতিমালা বাস্তবায়ন শুরু',
      summary: 'বিভাগীয় প্রশাসন জলাভূমি অবৈধভাবে ভরাট রোধে কঠোর অবস্থান নিয়েছে। সংশ্লিষ্ট ভূমি অফিসকে তদারকি বাড়াতে বলা হয়েছে।',
      date: daysAgo(9),
      source: 'খুলনা বিভাগীয় কমিশনার',
      url: 'https://khulnadiv.gov.bd/site/notices',
      isNew: false,
      important: false
    },
    // ─── চাকরি সংক্রান্ত ───
    {
      id: 'job_001',
      category: 'job',
      title: '৪৭তম BCS পরীক্ষার সময়সূচি চূড়ান্ত — BPSC বিজ্ঞপ্তি',
      summary: 'বাংলাদেশ সরকারি কর্ম কমিশন ৪৭তম BCS লিখিত পরীক্ষার চূড়ান্ত সময়সূচি প্রকাশ করেছে। প্রবেশপত্র ডাউনলোড শুরু হবে নির্ধারিত তারিখ থেকে।',
      date: daysAgo(1),
      source: 'BPSC',
      url: 'https://bpsc.gov.bd',
      isNew: true,
      important: true
    },
    {
      id: 'job_002',
      category: 'job',
      title: 'যশোর জেলা প্রশাসকের কার্যালয়ে নিয়োগ বিজ্ঞপ্তি প্রকাশিত',
      summary: 'যশোর জেলা প্রশাসকের কার্যালয়ে বিভিন্ন পদে জনবল নিয়োগের বিজ্ঞপ্তি প্রকাশ পেয়েছে। আগ্রহীদের নির্ধারিত ফরমে আবেদন করতে বলা হয়েছে।',
      date: daysAgo(3),
      source: 'যশোর DC অফিস',
      url: 'https://jessore.gov.bd/site/notices',
      isNew: false,
      important: true
    },
    {
      id: 'job_003',
      category: 'job',
      title: 'সরকারি কর্মকর্তা-কর্মচারীদের বার্ষিক গোপনীয় প্রতিবেদন (ACR) অনলাইনে জমার নির্দেশ',
      summary: 'জনপ্রশাসন মন্ত্রণালয় সকল সরকারি কর্মকর্তা-কর্মচারীদের ACR অনলাইন সিস্টেমে জমা দেওয়ার নির্দেশ দিয়েছে।',
      date: daysAgo(6),
      source: 'জনপ্রশাসন মন্ত্রণালয়',
      url: 'https://mopa.gov.bd',
      isNew: false,
      important: false
    },
    {
      id: 'job_004',
      category: 'job',
      title: 'ভূমি অফিসের তৃতীয়-চতুর্থ শ্রেণীর কর্মচারী নিয়োগে নতুন বিধিমালা',
      summary: 'ভূমি মন্ত্রণালয়ের অধীন সকল অফিসে তৃতীয় ও চতুর্থ শ্রেণীর কর্মচারী নিয়োগে নতুন যোগ্যতা ও প্রক্রিয়া নির্ধারণ করা হয়েছে।',
      date: daysAgo(10),
      source: 'ভূমি মন্ত্রণালয়',
      url: 'https://minland.gov.bd',
      isNew: false,
      important: false
    },
    // ─── সাধারণ গুরুত্বপূর্ণ ───
    {
      id: 'gen_001',
      category: 'general',
      title: 'ই-নামজারি পোর্টালে নতুন ফিচার — আবেদনের স্ট্যাটাস SMS-এ জানা যাবে',
      summary: 'mutation.land.gov.bd পোর্টালে নতুন SMS নোটিফিকেশন ফিচার যোগ করা হয়েছে। আবেদনের প্রতিটি ধাপে আবেদনকারীকে SMS পাঠানো হবে।',
      date: daysAgo(4),
      source: 'ই-নামজারি পোর্টাল',
      url: 'https://mutation.land.gov.bd',
      isNew: false,
      important: false
    },
    {
      id: 'gen_002',
      category: 'general',
      title: 'ভূমি রেকর্ড ও জরিপ অধিদফতরে অনলাইনে খতিয়ান আবেদনের সুবিধা চালু',
      summary: 'এখন থেকে অনলাইনে RS, SA ও BRS খতিয়ানের নকল আবেদন করা যাবে। dlrs.gov.bd পোর্টালের মাধ্যমে আবেদন ও ফি প্রদান করতে হবে।',
      date: daysAgo(7),
      source: 'ভূমি রেকর্ড অধিদফতর',
      url: 'https://dlrs.gov.bd',
      isNew: false,
      important: false
    }
  ];
}

// ────────────────────────────────────
// ক্যাশ থেকে নিউজ লোড করা
// ────────────────────────────────────
function loadNewsFromCache() {
  try {
    const cached = localStorage.getItem(NEWS_CACHE_KEY);
    if (cached) {
      const { data, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < NEWS_CACHE_TTL) {
        return data;
      }
    }
  } catch (e) {}
  return null;
}

function saveNewsToCache(data) {
  try {
    localStorage.setItem(NEWS_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
  } catch (e) {}
}

// ────────────────────────────────────
// লোডিং স্কেলিটন দেখানো (স্পিনারের বদলে আধুনিক shimmer কার্ড)
// ────────────────────────────────────
function showNewsSkeleton() {
  const container = document.getElementById('news-list-container');
  if (!container) return;
  let html = '';
  for (let i = 0; i < 4; i++) {
    html += `<div class="news-skel">
      <div class="news-skel-line w40"></div>
      <div class="news-skel-line w90"></div>
      <div class="news-skel-line w60"></div>
    </div>`;
  }
  container.innerHTML = html;
}

// Worker থেকে আসা একটা raw item কে অ্যাপের ব্যবহারের জন্য normalize করা
function normalizeWorkerItem(i) {
  // Worker date না পেলে null পাঠায় — তখন আজকের তারিখ বসানো হবে না (ভুল তথ্য এড়াতে),
  // বরং fetchedAt (Worker কখন আইটেমটা সংগ্রহ করেছে) দেখানো হবে এবং "তারিখ অনুপলব্ধ" চিহ্নিত হবে
  let dateVal = null;
  let dateUnknown = false;
  if (i.date) {
    const d = new Date(i.date);
    dateVal = isNaN(d.getTime()) ? null : d;
  }
  if (!dateVal) {
    dateUnknown = true;
    dateVal = i.fetchedAt ? new Date(i.fetchedAt) : new Date();
  }
  return {
    ...i,
    date: dateVal,
    dateUnknown,
    isFallback: false
  };
}

// ────────────────────────────────────
// নিউজ লোড করা — cache → Worker (real) → static (শুধু ব্যর্থ হলে fallback)
// forceRefresh true হলে Worker এর /refresh এ কল করে আসলেই নতুন স্ক্র্যাপ ট্রিগার করে,
// নাহলে /news এ কল করে যা cache এ আছে তাই আনে (দ্রুত)
// ────────────────────────────────────
async function loadNews(forceRefresh = false) {
  const container = document.getElementById('news-list-container');
  if (!container) return;

  let items = null;

  if (!forceRefresh) {
    items = loadNewsFromCache();
  }

  if (!items) {
    showNewsSkeleton();

    const targetUrl = forceRefresh ? NEWS_REFRESH_URL : NEWS_WORKER_URL;

    try {
      const res = await fetch(targetUrl, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const json = await res.json();
        // /refresh এন্ডপয়েন্ট success/count ফেরত দেয়, ডেটা না — তাই refresh এর পর /news আবার কল করে আসল লিস্ট আনি
        let rawItems = json.items;
        if (forceRefresh && !rawItems) {
          const res2 = await fetch(NEWS_WORKER_URL, { signal: AbortSignal.timeout(10000) });
          if (res2.ok) {
            const json2 = await res2.json();
            rawItems = json2.items;
          }
        }
        if (rawItems && rawItems.length > 0) {
          items = rawItems.map(normalizeWorkerItem);
          newsUsingFallback = false;
        }
      }
    } catch (e) {
      console.warn('Worker থেকে ডেটা আনা যায়নি, নমুনা নিউজ দেখানো হচ্ছে:', e.message);
    }

    // Worker না থাকলে বা ব্যর্থ হলে static/নমুনা নিউজ
    if (!items) {
      items = getStaticNews().map(it => ({ ...it, date: new Date(it.date), dateUnknown: false }));
      newsUsingFallback = true;
    }

    // তারিখ অনুযায়ী sort করো (নতুন আগে)
    items.sort((a, b) => new Date(b.date) - new Date(a.date));
    saveNewsToCache(items);
  } else {
    // cache থেকে আসা ডেটার date স্ট্রিং কে Date object এ ফিরিয়ে আনা
    items = items.map(it => ({ ...it, date: new Date(it.date) }));
    newsUsingFallback = items.some(it => it.isFallback);
  }

  allNewsItems = items;
  updateNewsLastTime();
  renderNewsList(allNewsItems);
}

function updateNewsLastTime() {
  const row = document.getElementById('news-last-upd-row');
  const span = document.getElementById('news-last-upd-time');
  if (row && span) {
    row.style.display = 'block';
    span.textContent = new Date().toLocaleString('bn-BD', {
      day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }
}

// ────────────────────────────────────
// নিউজ রেন্ডার করা
// ────────────────────────────────────
function renderNewsList(items) {
  const container = document.getElementById('news-list-container');
  if (!container) return;

  const filtered = currentNewsFilter === 'all'
    ? items
    : items.filter(n => n.category === currentNewsFilter);

  // Worker থেকে real ডেটা না পেলে উপরে একটা সতর্কবার্তা দেখানো হবে,
  // যাতে বোঝা যায় নিচের তালিকা নমুনা, real সংবাদ নয়
  const fallbackBanner = newsUsingFallback ? `
    <div style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.35);border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px;color:var(--yellow);line-height:1.6">
      ⚠️ <b>সরাসরি সরকারি সাইট থেকে এখন সংযোগ করা যাচ্ছে না — নিচে নমুনা তথ্য দেখানো হচ্ছে।</b><br>
      নিচের লিংকে গিয়ে আসল হালনাগাদ তথ্য দেখুন, অথবা একটু পরে রিফ্রেশ করুন।
    </div>` : '';

  if (!filtered || filtered.length === 0) {
    container.innerHTML = fallbackBanner + `<div class="news-loading">
      <div style="font-size:36px;margin-bottom:10px">🔍</div>
      <div>এই বিভাগে কোনো সংবাদ পাওয়া যায়নি</div>
    </div>`;
    return;
  }

  const badgeMap = {
    land:    { cls: 'land',    label: '🏛️ ভূমি' },
    dc:      { cls: 'dc',      label: '🏢 যশোর DC' },
    comm:    { cls: 'comm',    label: '🟣 খুলনা কমিশনার' },
    job:     { cls: 'job',     label: '💼 চাকরি' },
    gazette: { cls: 'gazette', label: '📜 গেজেট' },
    general: { cls: 'general', label: '📋 সাধারণ' }
  };

  container.innerHTML = fallbackBanner + filtered.map((item, idx) => {
    const b = badgeMap[item.category] || badgeMap.general;

    const dateStr = item.date instanceof Date
      ? item.date.toLocaleDateString('bn-BD', { day: 'numeric', month: 'long', year: 'numeric' })
      : (item.date || '');

    // তারিখ অজানা হলে স্পষ্টভাবে বলে দেওয়া হয় (ভুল করে আজকের তারিখ "প্রকাশের তারিখ" বলে চালানো হয় না)
    const dateLabel = item.dateUnknown
      ? `সংগৃহীত: ${dateStr}`
      : dateStr;

    const isImportant = item.important
      || IMPORTANT_KEYWORDS.some(kw => (item.title||'').includes(kw) || (item.summary||'').includes(kw));

    const detailId = 'nd-' + idx;
    const btnId    = 'nb-' + idx;

    const hasSummary = item.summary && item.summary.trim().length > 0;
    const detailHtml = hasSummary
      ? item.summary
      : 'এই নোটিশের সংক্ষিপ্ত বিবরণ পাওয়া যায়নি — সম্পূর্ণ বিস্তারিত জানতে নিচের "মূল সংবাদ পড়ুন" বাটনে ক্লিক করুন।';

    return `
    <div class="news-card cat-${item.category} ${isImportant ? 'is-important' : ''}">
      <div class="news-card-body">

        <!-- badge + তারিখ -->
        <div class="news-card-top">
          <span class="news-badge ${b.cls}">${b.label}</span>
          ${item.isNew ? '<span class="news-badge-new">🆕 নতুন</span>' : ''}
          ${isImportant ? '<span class="news-badge-imp">⚡ গুরুত্বপূর্ণ</span>' : ''}
          <span class="news-date">📅 ${dateLabel}</span>
        </div>

        <!-- headline — ক্লিক করলে বিস্তারিত টগল হবে (লিংকে যায় না, সংক্ষেপে এখানেই দেখায়) -->
        <div class="news-headline" onclick="toggleNewsDetail('${detailId}','${btnId}')">
          ${item.title}
        </div>

        <!-- বিস্তারিত — লুকানো থাকে, ক্লিকে খোলে -->
        <div class="news-detail" id="${detailId}">
          ${detailHtml}
          <div style="margin-top:10px;font-size:12px;color:var(--muted)">
            📌 সূত্র: <b style="color:var(--text)">${item.source || ''}</b>
          </div>
        </div>

        <!-- action বাটন -->
        <div class="news-card-actions">
          <button class="news-detail-btn" id="${btnId}" onclick="toggleNewsDetail('${detailId}','${btnId}')">
            <span>📖</span> <span>সংক্ষেপে দেখুন</span>
          </button>
          <a class="news-source-link" href="${item.url}" target="_blank" rel="noopener">
            🔗 মূল সংবাদ পড়ুন ↗
          </a>
        </div>

      </div>
    </div>`;
  }).join('');
}

// বিস্তারিত toggle করার ফাংশন
function toggleNewsDetail(detailId, btnId) {
  const detail = document.getElementById(detailId);
  const btn    = document.getElementById(btnId);
  if (!detail) return;
  const isOpen = detail.classList.contains('open');
  detail.classList.toggle('open', !isOpen);
  if (btn) {
    btn.classList.toggle('active', !isOpen);
    const span = btn.querySelector('span:last-child');
    if (span) span.textContent = isOpen ? 'সংক্ষেপে দেখুন' : 'বিস্তারিত লুকান';
  }
}

// ────────────────────────────────────
// ফিল্টার
// ────────────────────────────────────
function filterNews(cat, btn) {
  currentNewsFilter = cat;
  document.querySelectorAll('.news-tab-chip').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderNewsList(allNewsItems);
}

// ────────────────────────────────────
// রিফ্রেশ বাটন
// ────────────────────────────────────
async function refreshNews() {
  const btn = document.getElementById('news-refresh-btn');
  const icon = document.getElementById('news-refresh-icon');
  if (btn) { btn.disabled = true; }
  if (icon) { icon.textContent = '⏳'; }

  // ক্যাশ মুছে নতুন করে লোড
  try { localStorage.removeItem(NEWS_CACHE_KEY); } catch (e) {}
  await loadNews(true);

  if (btn) { btn.disabled = false; }
  if (icon) { icon.textContent = '🔄'; }

  if (newsUsingFallback) {
    showToast('⚠️ সরকারি সাইট থেকে সংযোগ করা যায়নি, নমুনা তথ্য দেখানো হচ্ছে', 'error');
  } else {
    showToast('✅ সংবাদ আপডেট হয়েছে');
  }
}

// ────────────────────────────────────
// ট্যাব খুললে প্রথমবার লোড হবে
// প্রতি ৩০ মিনিটে নিউজ ক্যাশ expire হয় — পরের বার ট্যাব খুললে নতুন ডেটা আসবে
// ────────────────────────────────────

// প্রতি ১ মিনিটে ড্যাশবোর্ড রিফ্রেশ হয়
setInterval(renderDashboard, 60000);
