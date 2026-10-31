/* ระบบงานช่าง — หน้าเว็บใน LINE (LIFF)
 * หน้า: #board (บอร์ดงาน) · #job/0131 (หน้างาน) · #review (คิวตรวจข้อเสนอของ AI)
 * ทุกคำขอส่ง ID token ของ LINE ไป Apps Script ซึ่งตรวจตัวตน + ชีต Staff เอง (หน้าเว็บนี้ไม่มีความลับ)
 */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG;
  const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  // ขั้นหลักของงาน (แถบสถานะแบบ Grab) · ยกเลิก แยกเป็นปุ่ม
  const FLOW = ['รับแจ้ง', 'ติดต่อลูกค้า', 'ตรวจเช็ค', 'รอใบเสนอราคา', 'รอลูกค้าคอนเฟิร์ม', 'ซ่อม', 'รออะไหล่', 'เสร็จ รอลูกค้ารับ', 'ปิด'];
  // ช่วงงาน → สีแถบ (บอร์ด / ภาพรวม / สถิติ)
  const PHASE = {
    'รับแจ้ง': 'start', 'ติดต่อลูกค้า': 'start',
    'ตรวจเช็ค': 'assess', 'รอใบเสนอราคา': 'assess', 'รอลูกค้าคอนเฟิร์ม': 'assess',
    'ซ่อม': 'repair', 'รออะไหล่': 'repair',
    'เสร็จ รอลูกค้ารับ': 'done',
    'ปิด': 'closed', 'ยกเลิก': 'closed', 'รวมกับงานอื่น': 'closed'
  };
  const PHASE_NAME = { start: 'เริ่มงาน', assess: 'ตรวจ / เสนอราคา', repair: 'ซ่อม', done: 'เสร็จ รอลูกค้ารับ', closed: 'ปิดแล้ว' };
  const ph = status => 'ph-' + (PHASE[status] || 'closed');
  const pref = (k, v) => { // จำตัวเลือกของคนดู (ถ้าเบราว์เซอร์ไม่ให้เก็บก็ไม่เป็นไร)
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { /* ไม่ต้องทำอะไร */ }
    return null;
  };
  const SHORT = { 'รอลูกค้าคอนเฟิร์ม': 'รอคอนเฟิร์ม', 'เสร็จ รอลูกค้ารับ': 'เสร็จ รอรับ', 'รอใบเสนอราคา': 'รอใบเสนอราคา' };
  const ERRORS = {
    not_staff: 'บัญชี LINE นี้ยังไม่อยู่ในชีต Staff — ให้พิมพ์ข้อความในกลุ่มงานสักครั้ง แล้วให้ผู้ดูแลใส่ชื่อในชีต Staff',
    not_configured: 'ระบบยังตั้งค่าไม่ครบ (LINE_LOGIN_CHANNEL_ID) แจ้งผู้ดูแล',
    not_found: 'ไม่พบงานนี้', bad_status: 'สถานะไม่ถูกต้อง', past_date: 'วันตามต้องเป็นวันนี้หรือหลังจากนี้',
    bad_date: 'วันที่ไม่ถูกต้อง', closed: 'งานปิดแล้ว ตั้งวันตามไม่ได้', already_decided: 'มีคนตัดสินข้อนี้ไปแล้ว',
    already_in_job: 'ข้อความนี้อยู่ในงานแล้ว', not_found_job: 'ไม่พบเลขงานที่จะแนบ', not_found_part: 'ไม่พบรายการถอดอะไหล่นี้', busy: 'ระบบไม่ว่าง ลองใหม่อีกครั้ง',
    unknown_action: 'ระบบยังไม่รองรับคำสั่งนี้ (อาจยังไม่ได้ deploy)', nothing_selected: 'ยังไม่ได้เลือกข้อ', not_in_job: 'ข้อความนี้ไม่ได้อยู่ในงานนี้แล้ว (มีคนย้ายไปก่อน) โหลดหน้าใหม่',
    same_job: 'เลือกงานเดิม ไม่ต้องย้าย', no_title: 'ใส่ชื่องานก่อน',
    need_fix_note: 'ปิดงานต้องใส่สรุปการแก้ไข (อย่างน้อย 10 ตัวอักษร)', server_error: 'เกิดข้อผิดพลาดที่ระบบ (บันทึกในชีต Errors แล้ว)'
  };

  const READ_ACTIONS = ['me', 'board', 'job', 'thumb', 'review'];
  const $app = document.getElementById('app');
  const state = { me: null, board: null, filter: 'open', query: '', thumbs: {} };

  // ---------- ตัวช่วย ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.getDate() + ' ' + MONTHS[d.getMonth()];
  };
  const fmtDateTime = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    return fmtDate(iso) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  const fmtKey = key => { // yyyy-MM-dd → 9 ต.ค.
    const p = String(key).split('-').map(Number);
    return p.length === 3 ? p[2] + ' ' + MONTHS[p[1] - 1] : '';
  };
  const todayKey = (offsetDays = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const nextBusinessKey = () => { // วันทำการถัดไป (ข้ามวันอาทิตย์) ตรงกับระบบ
    const d = new Date();
    do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const shortStatus = s => SHORT[s] || s;
  const noDigits = no => String(no).replace(/\D/g, '');

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2500);
  }

  const API_TIMEOUT_MS = 45000;
  // บอร์ด/หน้างานอ่านจาก D1 (Cloudflare) เร็วกว่าชีตหลายเท่า · ล้มเหลว/ยังไม่ซิงก์ค่อยถาม Apps Script
  const D1_ACTIONS = ['board', 'job'];
  // บันทึกยังเขียนผ่าน Apps Script (ชีตเป็นตัวหลัก) แล้วสั่งซิงก์ให้ D1 ตามทันที
  const WRITE_ACTIONS = ['update', 'moveMsgs', 'newJob', 'decide', 'decideMany'];
  // หลังย้ายระบบ (Worker ตอบ primary = d1): ทุกคำขอไป Worker ที่เดียว ไม่ผ่าน Apps Script
  // จำค่าไว้ในเครื่อง · Apps Script ตอบ moved = ย้ายแล้ว → ไป Worker · Worker ตอบ not_primary = สลับกลับ → ไป Apps Script
  function setPrimary(v) {
    state.primary = v === 'd1' ? 'd1' : 'sheet';
    try { localStorage.setItem('primary', state.primary); } catch (e) { /* โหมดส่วนตัว */ }
  }
  try { state.primary = localStorage.getItem('primary') || 'sheet'; } catch (e) { state.primary = 'sheet'; }
  // viaSheet = Worker ไม่ตอบ (ล่ม) → ลอง Apps Script แทน (โหมดฉุกเฉิน: ผู้ดูแลตั้งชีตกลับเป็นตัวหลัก)
  async function api(action, data, attempt = 1, viaSheet = false) {
    if (CFG.CORE_URL && state.primary === 'd1' && !viaSheet) {
      try {
        return await core(action, data, READ_ACTIONS.indexOf(action) >= 0 ? 20000 : API_TIMEOUT_MS);
      } catch (err) {
        if (err.network) return api(action, data, attempt, true);
        if (err.code !== 'not_primary') throw err;
        setPrimary('sheet');
      }
    }
    if (attempt === 1 && !viaSheet && CFG.CORE_URL && D1_ACTIONS.indexOf(action) >= 0) {
      try {
        if (data && data.fresh) state.syncing = state.syncing || syncD1();
        if (state.syncing) await state.syncing;
        return await core(action, data, 15000);
      } catch (err) {
        if (err.message === 'login') throw err;
        console.warn(action, 'อ่านจาก D1 ไม่ได้ ใช้ Apps Script แทน:', err.message);
      }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    let out;
    try {
      // มี Worker (Cloudflare) ใช้ Worker ก่อน อ่านเร็วกว่ามาก · ไม่มีก็เรียก Apps Script ตรงเหมือนเดิม
      const res = await fetch(CFG.WORKER_URL || CFG.API_URL, {
        method: 'POST', // ไม่ใส่ header เพิ่ม = text/plain ไม่ต้องมี preflight (Apps Script ไม่รองรับ OPTIONS)
        body: JSON.stringify(Object.assign({ action, idToken: liff.getIDToken() }, data || {})),
        signal: ctrl.signal
      });
      out = await res.json();
    } catch (err) {
      // เน็ตหลุด / ระบบไม่ตอบ: อ่านข้อมูลลองซ้ำ 1 ครั้ง (การบันทึกไม่ลองซ้ำเอง กันบันทึกซ้อน)
      if (attempt === 1 && READ_ACTIONS.indexOf(action) >= 0) return api(action, data, 2, viaSheet);
      throw new Error('เชื่อมต่อไม่สำเร็จ (เน็ตหลุดหรือระบบตอบช้า) ลองใหม่อีกครั้ง');
    } finally {
      clearTimeout(timer);
    }
    if (out.ms) console.log(action, out.ms + ' ms');
    if (out.error === 'login_expired' || out.error === 'login_required') {
      liff.login({ redirectUri: location.href });
      throw new Error('login');
    }
    if (out.error === 'moved' && viaSheet) throw new Error('ระบบหลักไม่ตอบ ลองใหม่อีกครั้งในอีกสักครู่');
    if (out.error === 'moved' && CFG.CORE_URL && state.primary !== 'd1') { setPrimary('d1'); return api(action, data, attempt); }
    if (viaSheet && !out.error && state.primary === 'd1') setPrimary('sheet'); // ชีตรับแล้ว = โหมดฉุกเฉิน
    if (out.error) throw new Error(ERRORS[out.error] || out.error);
    if (CFG.CORE_URL && WRITE_ACTIONS.indexOf(action) >= 0) state.syncing = syncD1();
    return out;
  }
  function syncD1() {
    const p = core('sync', {}, 30000).catch(() => {}).then(() => { if (state.syncing === p) state.syncing = null; });
    return p;
  }

  function showError(err) {
    if (err.message === 'login') return;
    $app.innerHTML = '<div class="center"><p>⚠️ ' + esc(err.message) + '</p><button class="btn" onclick="location.reload()">ลองใหม่</button></div>';
  }

  function sheet(html, onReady) {
    const el = document.getElementById('sheet');
    el.innerHTML = '<div class="panel">' + html + '</div>';
    el.hidden = false;
    el.onclick = e => { if (e.target === el || e.target.dataset.close !== undefined) closeSheet(); };
    if (onReady) onReady(el);
  }
  function closeSheet() {
    const el = document.getElementById('sheet');
    el.hidden = true;
    el.innerHTML = '';
  }

  function setBadge(n) {
    const b = document.getElementById('review-badge');
    b.textContent = n;
    b.hidden = !n;
  }

  // หน้าที่โหลดช้า (เช่น สถิติ) ตอบกลับมาหลังผู้ใช้กดไปแท็บอื่นแล้ว ต้องไม่วาดทับหน้าใหม่
  // ทุก render เรียก claim() ตอนเริ่ม แล้วเช็ก live() หลัง await ทุกครั้ง
  let renderSeq = 0;
  function claim() { const my = ++renderSeq; return () => my === renderSeq; }

  function setTab(tab) {
    document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
    const cur = document.querySelector('.tabs a.active');
    if (cur) cur.scrollIntoView({ inline: 'nearest', block: 'nearest' }); // แท็บที่เลือกอยู่ต้องเห็นเสมอ
    tabHints();
  }

  // แท็บล้นจอ: ขอบจาง + ปุ่ม ‹ › บอกว่ายังมีแท็บซ่อนอยู่ฝั่งไหน
  function tabHints() {
    const nav = document.getElementById('tabs'), wrap = document.getElementById('tabs-wrap');
    if (!nav || !wrap) return;
    wrap.classList.toggle('more-left', nav.scrollLeft > 4);
    wrap.classList.toggle('more-right', nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 4);
  }
  (() => {
    const nav = document.getElementById('tabs');
    if (!nav) return;
    nav.addEventListener('scroll', tabHints, { passive: true });
    window.addEventListener('resize', tabHints);
    document.getElementById('tab-right').onclick = () => nav.scrollBy({ left: nav.clientWidth * 0.7 });
    document.getElementById('tab-left').onclick = () => nav.scrollBy({ left: -nav.clientWidth * 0.7 });
    tabHints();
    if (document.fonts) document.fonts.ready.then(tabHints);
  })();

  // ---------- บอร์ดงาน ----------
  async function renderBoard() {
    setTab('board');
    const live = claim();
    if (state.board) drawBoard(); // แสดงของเดิมทันที แล้วโหลดใหม่ตามหลัง
    else $app.innerHTML = '<div class="center muted">กำลังโหลดงาน…</div>';
    const fresh = await api('board', state.forceFresh ? { fresh: true } : {});
    if (!live()) return;
    state.forceFresh = false;
    state.board = fresh;
    if (fresh.reviewCount !== undefined) setBadge(fresh.reviewCount); // D1 ไม่มีจำนวนคิว (มาจาก me แทน)
    if (location.hash === '' || location.hash === '#board') drawBoard();
  }

  // listOnly = พิมพ์ค้นหา: วาดเฉพาะรายการ ไม่สร้างช่องค้นหาใหม่ (สร้างใหม่ทุกตัวอักษร = คีย์บอร์ดมือถือเด้งกลับภาษาเริ่มต้น)
  function drawBoard(listOnly) {
    state.boardView = state.boardView || pref('boardView') || 'list';
    if (state.boardView === 'dash') return drawDashboard();
    if (state.boardView === 'daily') return drawDaily();
    const b = state.board;
    const q = state.query.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    let jobs = b.jobs.filter(j => !j.merged);
    const counts = {
      open: jobs.filter(j => !j.closed).length,
      due: jobs.filter(j => j.due).length,
      quiet: jobs.filter(j => !j.closed && !j.due && j.quietDays >= b.silentDays).length,
      closed: jobs.filter(j => j.closed).length
    };
    if (q) {
      jobs = jobs.filter(j => (j.no + ' ' + j.title + ' ' + j.customer + ' ' + j.owner).toLowerCase().includes(q) ||
        (qDigits.length >= 4 && j.phone.replace(/\D/g, '').includes(qDigits)));
    } else if (state.filter.indexOf('status:') === 0) {
      jobs = jobs.filter(j => j.status === state.filter.slice(7));
    } else if (state.filter.indexOf('product:') === 0) {
      jobs = jobs.filter(j => !j.closed && j.product === state.filter.slice(8));
    } else {
      jobs = jobs.filter(j => state.filter === 'open' ? !j.closed : state.filter === 'due' ? j.due
        : state.filter === 'quiet' ? !j.closed && !j.due && j.quietDays >= b.silentDays : j.closed);
    }
    const chip = (key, label) => '<button class="chip' + (state.filter === key && !q ? ' on' : '') + '" data-filter="' + key + '">' +
      label + ' ' + counts[key] + '</button>';
    const chips = chip('open', 'เปิดอยู่') + chip('due', '⏰ ถึงวันตาม') + chip('quiet', '😶 เงียบ') + chip('closed', 'ปิดแล้ว') +
      (state.filter.indexOf(':') > 0 ? '<button class="chip on" data-filter="open">' + esc(state.filter.split(':')[1]) + ' ✕</button>' : '');
    let html = '';

    if (!jobs.length) html += '<div class="center muted">ไม่มีงาน</div>';
    const groups = q || state.filter === 'closed' ? [['', jobs]]
      : b.statuses.map(s => [s, jobs.filter(j => j.status === s)]).filter(g => g[1].length);
    groups.forEach(([title, list]) => {
      html += '<section class="group">' + (title ? '<div class="band ' + ph(title) + '">' + esc(title) +
        '<span class="n">' + list.length + ' งาน</span></div>' : '');
      list.forEach(j => { html += jobCardHtml(j, b.silentDays); });
      html += '</section>';
    });
    const bindFilters = () => $app.querySelectorAll('[data-filter]').forEach(btn => btn.onclick = () => {
      state.filter = btn.dataset.filter;
      state.query = '';
      drawBoard();
    });
    const listEl = document.getElementById('board-list');
    if (listOnly && listEl) {
      document.getElementById('board-chips').innerHTML = chips;
      listEl.innerHTML = html;
      return bindFilters();
    }
    $app.innerHTML = viewToggle() + asOfLine() + '<div class="toolbar"><input class="search" id="q" type="search" placeholder="ค้นหา เลขงาน ชื่อ ลูกค้า เบอร์" value="' +
      esc(state.query) + '"><div class="chips" id="board-chips">' + chips + '</div></div><div id="board-list">' + html + '</div>';
    const input = document.getElementById('q');
    input.oninput = () => { state.query = input.value; drawBoard(true); };
    bindFilters();
    bindViewToggle();
    bindRefresh();
  }

  // ข้อมูลบอร์ดมาจากที่พักข้อมูล (อัปเดตทุก 5 นาที และทันทีหลังบันทึก) · กดเพื่อดึงล่าสุดจากชีต
  function asOfLine() {
    const t = state.board && state.board.asOf;
    if (!t) return '';
    return '<p class="muted small asof">ข้อมูล ณ ' + esc(fmtDateTime(t)) + ' · <button class="link-btn" id="refresh">รีเฟรช</button></p>';
  }
  function bindRefresh() {
    const b = document.getElementById('refresh');
    if (b) b.onclick = () => { b.textContent = 'กำลังโหลด…'; state.forceFresh = true; renderBoard().catch(showError); };
  }

  function viewToggle() {
    const seg = (v, label) => '<button class="seg' + (state.boardView === v ? ' on' : '') + '" data-view="' + v + '">' + label + '</button>';
    return '<div class="view-toggle"><div class="segs">' + seg('list', 'รายการ') + seg('dash', 'ภาพรวม') + seg('daily', 'สรุปงาน') + '</div>' +
      '<button class="btn" id="qr-btn" title="QR เข้าระบบ / แชทน้องจ๊อบ">📱 QR</button>' +
      '<a class="btn primary new-job-btn" href="#new">＋ เปิดงาน</a></div><div style="height:10px"></div>';
  }
  function bindViewToggle() {
    const qb = document.getElementById('qr-btn');
    if (qb) qb.onclick = qrSheet;
    $app.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
      state.boardView = b.dataset.view;
      pref('boardView', state.boardView);
      drawBoard();
    });
  }

  // ---------- สรุปงานประจำวัน (ผู้ใช้ 31 ต.ค. 2569 · แทนข้อความสรุป 18:00 ในกลุ่ม) ----------
  // เปิดดูเช้าวันถัดไปหลังตรวจคิว (ค่าเริ่มต้น = เมื่อวาน) · Worker คำนวณสดทุกครั้ง ตรวจคิวเพิ่มแล้วตัวเลขของวันนั้นเปลี่ยนตาม
  const THB = 33;
  async function drawDaily() {
    const live = claim();
    const day = state.dailyDay || '';
    $app.innerHTML = viewToggle() + '<div class="center muted">กำลังสรุปงาน…</div>';
    bindViewToggle();
    let r;
    try { r = await core('daily', { day }, 30000); } catch (err) { if (live() && err.message !== 'login') $app.innerHTML = viewToggle() + '<div class="center muted">⚠️ ' + esc(err.message) + '</div>'; bindViewToggle(); return; }
    if (!live() || state.boardView !== 'daily') return;
    const a = r.ai, n = r.now, sy = r.system;
    const jobLink = j => '<a href="#job/' + noDigits(j.no) + '">' + esc(j.no) + '</a> ' + esc(j.title);
    const box = (title, inner) => '<div class="panel-box"><h3>' + title + '</h3>' + inner + '</div>';
    const li = list => list.length ? '<ul class="plain">' + list.map(x => '<li>' + x + '</li>').join('') + '</ul>' : '<p class="muted small">ไม่มี</p>';
    const baht = usd => '$' + usd.toFixed(2) + ' ≈ ' + Math.round(usd * THB) + ' บาท';
    let h = viewToggle() + '<div class="day-nav"><button class="btn" data-day="' + r.prev + '">‹</button><b>สรุปงาน ' + esc(fmtKey(r.day)) +
      (r.today ? ' (วันนี้)' : '') + '</b><button class="btn" data-day="' + r.next + '"' + (r.next ? '' : ' disabled') + '>›</button></div>';
    if (r.today) h += '<div class="note-flag">🕒 วันนี้ยังไม่จบ ตัวเลขยังเพิ่มได้ · สรุปที่ครบให้ดูพรุ่งนี้เช้า</div>';
    if (a.pending) h += '<a class="note-flag warn" href="#review">⚠️ ยังตรวจไม่ครบ: ข้อความของวันนี้ค้างในคิวตรวจ <b>' + a.pending + ' ข้อ</b> — ตัวเลขยังไม่ใช่ตัวสุดท้าย กดไปตรวจ ›</a>';
    else if (a.blocks && !r.today) h += '<div class="note-flag ok">✅ ตรวจคิวของวันนี้ครบแล้ว ตัวเลขเป็นตัวสุดท้าย</div>';
    const tile = (num, lbl, cls) => '<div class="tile' + (cls ? ' ' + cls : '') + '"><div class="num">' + num + '</div><div class="lbl">' + lbl + '</div></div>';
    h += '<div class="tiles">' + tile(r.jobs.opened.length, 'งานเข้า') + tile(r.jobs.closed.filter(j => j.status === 'ปิด').length, 'ปิดงาน') +
      tile(r.chat.total, 'ข้อความในกลุ่ม') + tile(a.pending, 'ค้างตรวจ', a.pending ? 'warn' : '') + '</div>';
    h += box('🆕 งานเข้า (' + r.jobs.opened.length + ')', li(r.jobs.opened.map(j => jobLink(j) + ' <span class="muted small">· ' + esc(j.by) + ' · ตอนนี้ ' + esc(j.status) + '</span>')));
    h += box('✅ ปิด / ยกเลิก (' + r.jobs.closed.length + ')', li(r.jobs.closed.map(j => jobLink(j) + ' <span class="muted small">· ' + esc(j.status) + '</span>' +
      (j.status !== 'ปิด' ? '' : j.repair === 'ยืนยันแล้ว' ? ' <span class="pill ok">📋 สรุปการซ่อมแล้ว</span>' : ' <span class="pill warn">ยังไม่สรุปการซ่อม</span>'))));
    const acc = a.judged - a.unsure;
    if (r.admin) h += box('🤖 AI อ่านแชท <span class="pill">ผู้บริหาร</span>', '<p>' + a.blocks + ' ก้อน · งานใหม่ ' + a.newJob + ' · อัปเดต ' + a.update + ' · ไม่เกี่ยว ' + a.notJob + ' · ไม่แน่ใจ ' + a.unsure + '</p>' +
      (a.judged ? '<p>คนตรวจแล้ว ' + a.judged + ' ข้อ · <b>ตรง ' + a.agree + '/' + acc + (acc ? ' (' + Math.round(a.agree * 100 / acc) + '%)' : '') + '</b> · พลาดงานใหม่ ' + a.missed +
        ' · เปิดเกิน ' + a.extra + '</p>' : '<p class="muted small">ยังไม่มีข้อที่คนตรวจ</p>') +
      '<p class="muted small">ค่า AI วันนี้ ' + baht(a.usd) + ' · ทั้งเดือนถึงวันนี้ ' + baht(a.usdMonth) + '</p>');
    h += box('💬 แชทกลุ่มหลัก', r.chat.total ? '<p>' + esc(r.chat.byType.join(' · ')) + '</p><p class="muted small">พิมพ์มากสุด: ' + esc(r.chat.top.join(' · ')) + '</p>' : '<p class="muted small">ไม่มีข้อความ</p>');
    h += box('📂 งานที่ต้องตาม (ณ ตอนนี้ · เปิดอยู่ ' + n.open + ' งาน)',
      '<p class="small"><b>⏰ ถึงวันตาม / เลยกำหนด (' + n.due.length + ')</b></p>' + li(n.due.map(j => jobLink(j) + ' <span class="muted small">· ' + esc(j.status) + ' · ' + (j.late > 0 ? 'เลยมา ' + j.late + ' วัน' : 'ตามวันนี้') + '</span>')) +
      '<p class="small"><b>😶 เงียบเกิน ' + n.silentDays + ' วันทำการ (' + n.silent.length + ')</b></p>' + li(n.silent.map(j => jobLink(j) + ' <span class="muted small">· ' + esc(j.status) + ' · เงียบ ' + j.quiet + ' วัน</span>')) +
      (n.repairPending.length ? '<p class="small"><b>📋 ปิดแล้วยังไม่สรุปการซ่อม (' + n.repairPending.length + ')</b></p><p>' +
        n.repairPending.map(no => '<a href="#job/' + noDigits(no) + '">' + esc(no) + '</a>').join(' ') + '</p>' : '') +
      '<p class="muted small">สถานะ: ' + esc(n.byStatus.map(x => x[0] + ' ' + x[1]).join(' · ')) + '</p>');
    const warn = [];
    if (sy) {   // สถานะระบบ: Worker ส่งมาเฉพาะผู้บริหาร/ผู้ทำระบบ
    if (!sy.mainOk) warn.push('ไม่พบห้องหลัก');
    if (sy.macOffline) warn.push('Mac ไม่ทำงานเกิน 35 นาที (ไฟล์ยังมีสำเนาใน R2)');
    if (sy.errors) warn.push('error ' + sy.errors + ' ครั้ง');
    if (sy.media.gone) warn.push('LINE ลบไฟล์ไปก่อนดึงทัน ' + sy.media.gone + ' ไฟล์');
    if (sy.unknownGroups.length) warn.push('กลุ่มที่ไม่รู้จัก: ' + sy.unknownGroups.join(', '));
    h += box('🛠️ ระบบ <span class="pill">ผู้บริหาร</span>', (warn.length ? '<p class="flag-due small">⚠️ ' + esc(warn.join(' · ')) + '</p>' : '<p class="small">✅ ปกติ</p>') +
      '<p class="muted small">📷 รูป ' + sy.media.image + ' · คลิป ' + sy.media.video + ' (เก็บแล้ว ' + sy.media.kept + ')' +
      (sy.macSeen ? ' · Mac ล่าสุด ' + esc(fmtDateTime(sy.macSeen)) : '') + '<br>' + esc(sy.backup) + '<br>📨 โควตา LINE เดือนนี้: ' + esc(sy.quota) +
      '<br>👥 Staff ' + sy.staff + ' คน' + (sy.noRole.length ? ' · ยังไม่ใส่บทบาท: ' + esc(sy.noRole.slice(0, 8).join(', ')) : '') + '</p>');
    }
    $app.innerHTML = h;
    bindViewToggle();
    $app.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { if (!b.dataset.day) return; state.dailyDay = b.dataset.day; drawDaily(); });
  }

  // ---------- QR เข้าระบบเร็ว (ผู้ใช้ 31 ต.ค. 2569: หาแชทน้องจ๊อบในไลน์ไม่เจอ) · โปสเตอร์ A4 ติดในแผนก ----------
  // เปิดงาน = LIFF ?view=new (หน้าแจ้งงานซ่อม · บันทึกแล้วปิดกลับแชท) · ระบบ = LIFF เฉยๆ (บอร์ดงาน) · แชท = oaMessage ของน้องจ๊อบ
  // โปสเตอร์สไตล์บัตรเข้างานกีฬาใหญ่ 2026 (ผู้ใช้ 31 ต.ค. 2569 · ไม่ใช้โลโก้/ถ้วย FIFA) · QR บนพื้นขาวขอบเงียบ ≥4 ช่อง
  const JOP_ID = '@696abybi';
  const QR_ITEMS = () => [
    { key: 'new', url: 'https://liff.line.me/' + CFG.LIFF_ID + '?view=new', title: '📝 เปิด Job', sub: 'สแกนเปิดงานซ่อม · บันทึกแล้วน้องจ๊อบส่งการ์ดยืนยันในแชท',
      en: 'OPEN JOB', th: 'เปิด Job', badge: 'สแกนเปิดงานซ่อม', pal: ['#FF4F12', '#E6007E', '#FFC400', '#1B1B3A'], code: 'CP-SVC-2026', fields: [['ACCESS', 'เปิดงาน'], ['ZONE', 'ทีมช่าง'], ['OPEN', '24 ชม.']],
      steps: ['เปิดกล้องมือถือ หรือ LINE › สแกน QR', 'เข้าหน้าเปิดงานซ่อมทันที (ครั้งแรกกดอนุญาต)', 'ถ่ายรูปเครื่อง ป้าย SN ใส่ลูกค้า › กดบันทึก'] },
    { key: 'jop', url: 'https://line.me/R/oaMessage/' + JOP_ID + '/', title: '💬 หลังบ้าน (น้องJob-ผู้ช่วยดูงาน)', sub: 'สแกนแล้วเข้าแชทน้องจ๊อบ คุย/ส่งรูปเปิดงาน และกดเมนูเข้าบอร์ดงาน (ยังไม่เป็นเพื่อน = เพิ่มเพื่อนก่อน)',
      avatar: 'jop.jpg?v=51', en: 'JOB ASSISTANT', th: 'หลังบ้าน (น้องJob-ผู้ช่วยดูงาน)', badge: 'LINE ' + JOP_ID, pal: ['#00A651', '#00C9A7', '#FFD200', '#0B3B2E'], code: 'CP-BOT-2026', fields: [['NAME', 'น้องจ๊อบ'], ['LINE', JOP_ID], ['OPEN', '24 ชม.']],
      steps: ['สแกน › เพิ่มเพื่อน › เข้าแชทน้องจ๊อบ', 'คุย ส่งรูป เล่าอาการ › น้องจ๊อบช่วยเปิดงาน', 'กดเมนูในแชท › บอร์ดงาน ค้นหา อะไหล่'] }];

  const PW = 1240, PH = 1754;   // A4 ที่ 150 dpi
  const TH = (w, px) => w + ' ' + px + 'px "Noto Sans Thai", sans-serif';
  const EN = (w, px) => w + ' ' + px + 'px "Anton", "Noto Sans Thai", sans-serif';
  function fitText(g, t, x, y, font, px, max, align) {
    do { g.font = font(px); px -= 2; } while (g.measureText(t).width > max && px > 14);
    g.textAlign = align || 'center'; g.fillText(t, x, y);
  }
  function spaced(g, t, cx, y, font, gap) {
    g.font = font;
    const w = [...t].reduce((a, ch) => a + g.measureText(ch).width + gap, -gap);
    let x = cx - w / 2;
    g.textAlign = 'left';
    [...t].forEach(ch => { g.fillText(ch, x, y); x += g.measureText(ch).width + gap; });
  }
  function drawQr(g, url, x0, y0, box) {
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    const n = qr.getModuleCount(), cell = Math.floor(box / n), size = cell * n, off = Math.floor((box - size) / 2);
    g.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) g.fillRect(x0 + off + k * cell, y0 + off + r * cell, cell, cell);
  }
  function rr(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  /** โหลดรูป (หน้าเว็บ) · ตัวทดสอบนอกเบราว์เซอร์ใส่ loadImgOverride มาแทน */
  const loadImg = src => typeof loadImgOverride === 'function' ? loadImgOverride(src)
    : new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
  const seeded = n => () => (n = (n * 16807) % 2147483647) / 2147483647;
  async function posterFonts() {
    try { await Promise.all(['800 60px "Noto Sans Thai"', '400 40px "Noto Sans Thai"', '400 60px "Anton"'].map(f => document.fonts.load(f))); } catch { /* ใช้ฟอนต์เครื่อง */ }
  }
  /** ลายบล็อกเรขาคณิตสีสด (แรงบันดาลใจงานกีฬาใหญ่ 2026): ตาราง + วงกลมเสี้ยว/ครึ่งวง/แถบ/สามเหลี่ยม/วงแหวน สุ่มแบบกำหนดเมล็ด */
  function blocks(g, pal, x0, y0, w, h, cell, seed) {
    const rnd = seeded(seed), pick = () => pal[Math.floor(rnd() * pal.length)];
    for (let y = y0; y < y0 + h; y += cell) for (let x = x0; x < x0 + w; x += cell) {
      const bg = pick(); let fg = pick(); if (fg === bg) fg = pal[(pal.indexOf(bg) + 1) % pal.length];
      g.fillStyle = bg; g.fillRect(x, y, cell, cell); g.fillStyle = fg;
      const t = Math.floor(rnd() * 7), q = Math.floor(rnd() * 4), cx = x + (q % 2) * cell, cy = y + (q > 1 ? cell : 0);
      g.beginPath();
      if (t === 0) { g.moveTo(cx, cy); g.arc(cx, cy, cell, 0, Math.PI * 2); g.save(); g.clip(); g.fillRect(x, y, cell, cell); g.restore(); }
      else if (t === 1) { g.arc(x + cell / 2, y + (q % 2 ? 0 : cell), cell / 2, 0, Math.PI * 2); g.save(); g.rect(x, y, cell, cell); g.clip(); g.fill(); g.restore(); }
      else if (t === 2) { for (let i = 0; i < 4; i++) g.fillRect(x, y + i * cell / 4, cell, cell / 8); }
      else if (t === 3) { g.moveTo(x, y); g.lineTo(x + cell, q % 2 ? y : y + cell); g.lineTo(x, y + cell); g.closePath(); g.fill(); }
      else if (t === 4) { g.lineWidth = cell / 6; g.strokeStyle = fg; g.arc(x + cell / 2, y + cell / 2, cell * 0.32, 0, Math.PI * 2); g.stroke(); }
      else if (t === 5) { g.arc(x + cell / 2, y + cell / 2, cell * 0.18, 0, Math.PI * 2); g.fill(); }
      else { g.fillRect(x, y, cell / 2, cell / 2); g.fillRect(x + cell / 2, y + cell / 2, cell / 2, cell / 2); }
    }
  }
  /** โปสเตอร์บัตรเข้างาน (access pass / ตั๋ว): พื้นลายบล็อกสีสด + บัตรขาวมีรูคล้องสาย + แถบหัวลาย + QR + ช่องข้อมูลแบบตั๋ว + รอยปรุตอนฉีก + บาร์โค้ด */
  async function posterPass(it) {
    await posterFonts();
    const P = it.pal;
    const c = document.createElement('canvas'); c.width = PW; c.height = PH;
    const g = c.getContext('2d');
    blocks(g, P, 0, 0, PW, PH, 155, 11 + it.key.length * 7);
    g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(0, 0, PW, PH);
    // บัตร (วาดแยกชั้น เจาะรู/รอยบากด้วย destination-out)
    const card = document.createElement('canvas'); card.width = PW; card.height = PH;
    const k = card.getContext('2d');
    const X = 110, Y = 60, W = PW - 220, H = PH - 120, cut = 1330;
    rr(k, X, Y, W, H, 46); k.fillStyle = '#ffffff'; k.fill();
    // แถบหัว: ลายบล็อกเล็ก + ไล่สีทับ ให้ตัวหนังสืออ่านง่าย
    k.save(); rr(k, X, Y, W, 470, 46); k.rect(X, Y + 46, W, 424); k.clip();
    blocks(k, P, X, Y, W, 470, 85, 5 + it.key.length);
    const hg = k.createLinearGradient(0, Y, 0, Y + 470); hg.addColorStop(0, 'rgba(0,0,0,.05)'); hg.addColorStop(1, 'rgba(0,0,0,.55)');
    k.fillStyle = hg; k.fillRect(X, Y, W, 470); k.restore();
    // แผ่นสีหลักทับครึ่งล่างของหัว (บล็อกตัวหนังสือ)
    k.fillStyle = P[0]; k.beginPath(); k.moveTo(X, Y + 250); k.lineTo(X + W, Y + 190); k.lineTo(X + W, Y + 470); k.lineTo(X, Y + 470); k.closePath(); k.fill();
    // ฟอยล์โฮโลแกรม (มุมขวาบน)
    const hx = X + W - 120, hy = Y + 130;
    const holo = k.createLinearGradient(hx - 70, hy - 70, hx + 70, hy + 70);
    ['#ff6ec7', '#ffd36e', '#7affc4', '#6ecbff', '#c16eff', '#ff6ec7'].forEach((col, i) => holo.addColorStop(i / 5, col));
    k.fillStyle = holo; k.beginPath(); k.arc(hx, hy, 70, 0, Math.PI * 2); k.fill();
    k.strokeStyle = 'rgba(255,255,255,.9)'; k.lineWidth = 4; k.stroke();
    k.fillStyle = 'rgba(20,20,30,.85)'; fitText(k, 'OFFICIAL', hx, hy - 4, px => EN(400, px), 30, 110); fitText(k, 'PASS', hx, hy + 30, px => EN(400, px), 30, 110);
    // ตัวหนังสือหัว
    rr(k, X + W / 2 - 300, Y + 92, 480, 76, 38); k.fillStyle = 'rgba(15,15,30,.72)'; k.fill();
    k.fillStyle = '#ffffff'; spaced(k, 'CORING PRO', X + W / 2 - 60, Y + 150, EN(400, 52), 10);
    k.save(); k.shadowColor = 'rgba(0,0,0,.35)'; k.shadowBlur = 10;
    k.fillStyle = '#ffffff'; fitText(k, it.en, X + W / 2, Y + 330, px => EN(400, px), 128, W - 120);
    k.fillStyle = P[1] === '#FFFFFF' ? '#111' : '#ffffff'; fitText(k, it.th, X + W / 2, Y + 430, px => TH(800, px), 72, W - 120);
    k.restore();
    // ป้ายประเภท + QR (ขาวรอบ QR ≥ 4 ช่อง)
    rr(k, X + W / 2 - 170, Y + 488, 340, 56, 28); k.fillStyle = '#111'; k.fill();
    k.fillStyle = '#fff'; fitText(k, it.badge, X + W / 2, Y + 527, px => TH(800, px), 30, 310);
    drawQr(k, it.url, X + W / 2 - 270, Y + 620, 540);
    // ช่องข้อมูลแบบตั๋ว 3 ช่อง
    const fy = Y + 1218, fw = (W - 120) / 3;
    it.fields.forEach(([lab, val], i) => {
      const fx = X + 60 + i * fw;
      if (i) { k.fillStyle = '#e3e3e8'; k.fillRect(fx - 2, fy - 6, 2, 96); }
      k.fillStyle = '#8a8a93'; fitText(k, lab, fx + fw / 2, fy + 22, px => EN(400, px), 26, fw - 30);
      k.fillStyle = '#111'; fitText(k, val, fx + fw / 2, fy + 72, px => TH(800, px), 38, fw - 30);
    });
    // รอยปรุ + รอยบากครึ่งวงกลมสองข้าง
    k.setLineDash([16, 14]); k.strokeStyle = '#c9c9d1'; k.lineWidth = 4;
    k.beginPath(); k.moveTo(X + 50, Y + cut - 10); k.lineTo(X + W - 50, Y + cut - 10); k.stroke(); k.setLineDash([]);
    // ตอนฉีก: ขั้นตอน + แถบสี + บาร์โค้ด
    it.steps.forEach((t, i) => {
      const y = Y + cut + 62 + i * 66;
      k.fillStyle = P[i % P.length]; k.beginPath(); k.arc(X + 92, y - 12, 24, 0, Math.PI * 2); k.fill();
      k.fillStyle = '#fff'; fitText(k, String(i + 1), X + 92, y - 1, px => EN(400, px), 30, 30);
      k.fillStyle = '#111'; fitText(k, t, X + 134, y, px => TH(400, px), 36, W - (it.avatar ? 440 : 360), 'left');
    });
    let face = null;
    if (it.avatar) try { face = await loadImg(it.avatar); } catch { /* ไม่มีรูป = ใช้บาร์โค้ดแทน */ }
    if (face) {   // รูปน้องจ๊อบ: วงกลมขอบขาว + วงสีหลัก + เงา (แทนบาร์โค้ด)
      const ax = X + W - 150, ay = Y + cut + 136, ar = 112;
      k.save(); k.shadowColor = 'rgba(0,0,0,.35)'; k.shadowBlur = 24; k.shadowOffsetY = 10;
      k.fillStyle = P[0]; k.beginPath(); k.arc(ax, ay, ar + 14, 0, Math.PI * 2); k.fill(); k.restore();
      k.fillStyle = '#fff'; k.beginPath(); k.arc(ax, ay, ar + 6, 0, Math.PI * 2); k.fill();
      k.save(); k.beginPath(); k.arc(ax, ay, ar, 0, Math.PI * 2); k.clip(); k.drawImage(face, ax - ar, ay - ar, ar * 2, ar * 2); k.restore();
    } else {
      const rnd = seeded(31);
      for (let x = X + W - 190; x < X + W - 50;) { const w = 2 + Math.floor(rnd() * 6); k.fillStyle = '#111'; k.fillRect(x, Y + cut + 30, w, 170); x += w + 2 + Math.floor(rnd() * 5); }
      k.fillStyle = '#8a8a93'; fitText(k, it.code, X + W - 120, Y + cut + 228, px => EN(400, px), 20, 150);
    }
    k.fillStyle = '#111'; fitText(k, 'เฉพาะทีมงาน · TEAM ONLY', X + 60, Y + H - 50, px => TH(800, px), 34, W - 340, 'left');
    P.forEach((col, i) => { k.fillStyle = col; k.fillRect(X + i * W / P.length, Y + H - 26, W / P.length + 1, 26); });
    k.save(); k.globalCompositeOperation = 'destination-in'; rr(k, X, Y, W, H, 46); k.fill(); k.restore();
    k.globalCompositeOperation = 'destination-out';
    rr(k, X + W / 2 - 90, Y + 26, 180, 30, 15); k.fill();                                    // รูคล้องสาย
    [X, X + W].forEach(x => { k.beginPath(); k.arc(x, Y + cut - 10, 34, 0, Math.PI * 2); k.fill(); });
    k.globalCompositeOperation = 'source-over';
    k.strokeStyle = 'rgba(255,255,255,.9)'; k.lineWidth = 5; rr(k, X + W / 2 - 92, Y + 24, 184, 34, 17); k.stroke();   // ขอบรูคล้องสาย
    // วางบัตรบนพื้น + เงา
    g.save(); g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 60; g.shadowOffsetY = 30; g.drawImage(card, 0, 0); g.restore();
    return c;
  }
  function openPoster(src, name) {
    sheet('<h2>🖨️ โปสเตอร์ A4</h2><p class="muted small">ถ้าไฟล์ไม่ดาวน์โหลดเอง (เช่นในแอปไลน์): กดค้างที่รูป → บันทึกรูป แล้วสั่งพิมพ์ขนาด A4 · หรือเปิดหน้านี้ในคอมแล้วพิมพ์</p>' +
      '<img class="poster-img" src="' + src + '" alt="' + esc(name) + '"><div class="actions"><button class="btn" id="p-back">‹ กลับ</button><button class="btn" data-close>ปิด</button></div>',
      el => { el.querySelector('#p-back').onclick = qrSheet; });
  }
  function qrSheet() {
    if (typeof qrcode !== 'function') return toast('โหลดตัวสร้าง QR ไม่ได้ ลองรีเฟรช');
    const items = QR_ITEMS();
    sheet('<h2>📱 QR เข้าระบบเร็ว</h2><p class="muted small">กด 🖨️ ได้โปสเตอร์ A4 ไปพิมพ์ติดผนัง/โต๊ะในแผนก · หรือคัดลอกลิงก์ส่งให้คนใหม่</p>' +
      items.map(it => '<div class="qr-card"><div class="qr-img" id="qr-' + it.key + '"></div><b>' + esc(it.title) + '</b><p class="muted small">' + esc(it.sub) + '</p>' +
        '<div class="actions"><button class="btn primary" data-pp="' + it.key + '">🖨️ โปสเตอร์ A4</button><button class="btn" data-qrcopy="' + it.key + '">🔗 คัดลอกลิงก์</button></div></div>').join('') +
      '<p class="muted small">💡 ในไลน์: กดค้างที่แชทน้องจ๊อบ → <b>ปักหมุด</b> ให้อยู่บนสุดเสมอ</p>' +
      '<div class="actions"><button class="btn" data-close>ปิด</button></div>', el => {
      items.forEach(it => {
        const c = document.createElement('canvas'); c.width = c.height = 300;
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 300, 300); drawQr(g, it.url, 10, 10, 280);
        const img = new Image(); img.src = c.toDataURL('image/png'); img.alt = it.title;
        el.querySelector('#qr-' + it.key).appendChild(img);
        el.querySelector('[data-qrcopy="' + it.key + '"]').onclick = async () => {
          try { await navigator.clipboard.writeText(it.url); toast('คัดลอกลิงก์แล้ว ✅'); } catch { prompt('คัดลอกลิงก์นี้', it.url); }
        };
        const make = (sel, fn) => el.querySelector(sel).onclick = async e => {
          e.target.textContent = 'กำลังสร้าง…';
          const src = (await fn(it)).toDataURL('image/png');
          const a = document.createElement('a'); a.href = src; a.download = 'poster-' + it.key + '.png'; a.click();
          openPoster(src, it.title);   // ในแอปไลน์ดาวน์โหลดไม่ได้: แสดงรูปให้กดค้างบันทึก
        };
        make('[data-pp="' + it.key + '"]', posterPass);
      });
    });
  }

  // ภาพรวมงาน: ตัวเลขสำคัญ + งานเปิดแยกช่วง/สถานะ/เจ้าของ/สินค้า · กดแล้วไปรายการที่กรองแล้ว
  function drawDashboard() {
    const b = state.board;
    const jobs = b.jobs.filter(j => !j.merged);
    const open = jobs.filter(j => !j.closed);
    const today = todayKey();
    const weekAgo = todayKey(-6);
    const k = iso => { if (!iso) return ''; const d = new Date(iso); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    const due = jobs.filter(j => j.due).length;
    const quiet = open.filter(j => !j.due && j.quietDays >= b.silentDays).length;
    const newToday = jobs.filter(j => k(j.opened) === today).length;
    const newWeek = jobs.filter(j => k(j.opened) >= weekAgo).length;
    const closedWeek = jobs.filter(j => j.status === 'ปิด' && k(j.closedAt) >= weekAgo).length;
    const tile = (num, lbl, filter, cls) => '<button class="tile' + (cls ? ' ' + cls : '') + '"' + (filter ? ' data-go="' + filter + '"' : '') +
      '><div class="num">' + num + '</div><div class="lbl">' + lbl + '</div></button>';
    let html = viewToggle() + '<div class="tiles">' +
      tile(open.length, 'งานเปิดอยู่', 'open') + tile(due, '⏰ ถึงวันตาม / เลยกำหนด', 'due', due ? 'warn' : '') +
      tile(quiet, '😶 เงียบเกิน ' + b.silentDays + ' วันทำการ', 'quiet', quiet ? 'bad' : '') +
      tile(newToday, 'งานเข้าวันนี้') + tile(newWeek, 'งานเข้า 7 วัน') + tile(closedWeek, 'ปิดงาน 7 วัน', 'closed') + '</div>';

    // งานเปิดแยกตามช่วงงาน (แถบซ้อน) + ทีละสถานะ
    html += '<div class="panel-box"><h3>งานเปิดอยู่ แยกตามขั้นตอน</h3><div class="stack">';
    ['start', 'assess', 'repair', 'done'].forEach(p => {
      const n = open.filter(j => PHASE[j.status] === p).length;
      if (n) html += '<span class="ph-' + p + '" style="flex:' + n + '" title="' + PHASE_NAME[p] + ' ' + n + '"></span>';
    });
    html += '</div>';
    const maxS = Math.max(1, ...b.statuses.map(s => open.filter(j => j.status === s).length));
    b.statuses.filter(s => PHASE[s] !== 'closed').forEach(s => {
      const n = open.filter(j => j.status === s).length;
      html += '<button class="hrow ' + ph(s) + '" data-go="status:' + esc(s) + '"><span class="lbl">' + esc(s) + '</span><span class="track"><span class="fill" style="width:' +
        (n / maxS * 100) + '%"></span></span><span class="val">' + n + ' งาน</span></button>';
    });
    html += '</div>';

    html += hbarsBox('งานเปิดอยู่ แยกตามสินค้า', open, j => j.product, 'product:');
    html += hbarsBox('งานเปิดอยู่ แยกตามเจ้าของงาน', open, j => j.owner || '-', '');
    $app.innerHTML = html;
    $app.querySelectorAll('[data-go]').forEach(t => t.onclick = () => {
      state.filter = t.dataset.go;
      state.query = '';
      state.boardView = 'list';
      pref('boardView', 'list');
      drawBoard();
      window.scrollTo(0, 0);
    });
    bindViewToggle();
  }

  // แถบแนวนอน (สีเดียว) + จำนวน + สัดส่วน
  function hbarsBox(title, list, keyFn, goPrefix) {
    const counts = {};
    list.forEach(j => { const k = keyFn(j); counts[k] = (counts[k] || 0) + 1; });
    const rows = Object.keys(counts).sort((a, b) => (a === 'ไม่ระบุ') - (b === 'ไม่ระบุ') || counts[b] - counts[a]);
    if (!rows.length) return '';
    const max = Math.max(...rows.map(r => counts[r]));
    let html = '<div class="panel-box"><h3>' + esc(title) + '</h3>';
    rows.forEach(r => {
      const pct = Math.round(counts[r] / list.length * 100);
      html += '<' + (goPrefix ? 'button' : 'div') + ' class="hrow"' + (goPrefix ? ' data-go="' + goPrefix + esc(r) + '"' : '') +
        '><span class="lbl">' + esc(r) + '</span><span class="track"><span class="fill" style="width:' + (counts[r] / max * 100) +
        '%"></span></span><span class="val">' + counts[r] + ' · ' + pct + '%</span></' + (goPrefix ? 'button' : 'div') + '>';
    });
    return html + '</div>';
  }

  function jobCardHtml(j, silentDays) {
    const meta = [];
    meta.push('<span class="pill ' + ph(j.status) + (j.closed ? ' closed' : '') + '">' + esc(shortStatus(j.status)) + '</span>');
    if (j.customer) meta.push(esc(j.customer));
    if (j.due) meta.push('<span class="flag-due">⏰ ตาม ' + esc(fmtKey(j.follow)) + '</span>');
    else if (j.follow && !j.closed) meta.push('ตาม ' + esc(fmtKey(j.follow)));
    if (!j.closed && j.quietDays >= silentDays) meta.push('<span class="flag-quiet">😶 เงียบ ' + j.quietDays + ' วัน</span>');
    meta.push('ล่าสุด ' + esc(fmtDate(j.last)));
    return '<a class="card ' + ph(j.status) + '" href="#job/' + noDigits(j.no) + '"><div class="top"><span class="no">' + esc(j.no) +
      '</span><span class="title">' + esc(j.title) + '</span></div><div class="meta">' + meta.join('') + '</div></a>';
  }

  // ---------- หน้างาน ----------
  async function renderJob(no) {
    setTab('');
    const live = claim();
    $app.innerHTML = '<div class="center muted">กำลังโหลดงาน…</div>';
    const data = await api('job', { no });
    if (live()) drawJob(data);
  }

  function drawJob(data) {
    const j = data.job;
    state.currentJob = j.no; // งานที่ถูกรวมเข้ามา: เหตุการณ์ของงานเดิมแสดงเลขงานกำกับ
    const idx = FLOW.indexOf(j.status);
    const off = idx < 0; // ยกเลิก / รวมกับงานอื่น
    let html = '<a class="back" href="#board">‹ บอร์ดงาน</a>';
    html += '<div class="job-head"><div class="row"><h1>' + esc(j.no) + ' ' + esc(j.title) +
      '</h1><button class="icon-btn" id="rename" title="แก้ชื่องาน">✏️</button></div>';
    const sub = [];
    if (j.customer) sub.push(esc(j.customer));
    if (j.phone) sub.push('<a href="tel:' + esc(j.phone) + '">' + esc(j.phone) + '</a>');
    sub.push('เจ้าของ ' + esc(j.owner || '-'));
    sub.push('เปิด ' + esc(fmtDate(j.opened)));
    html += '<div class="sub">' + sub.join(' · ') + '</div>';
    if (j.follow && !j.closed) html += '<div class="sub ' + (j.due ? 'flag-due' : '') + '">⏰ ตามต่อ ' + esc(fmtKey(j.follow)) + '</div>';
    if (data.mergedFrom.length) html += '<div class="sub small">รวมงาน ' + esc(data.mergedFrom.join(', ')) + ' เข้ามาแล้ว</div>';
    if (off) html += '<p><span class="pill">' + esc(j.status) + '</span></p>';
    html += '</div>';

    html += infoHtml(data) + repairHtml(data);
    html += '<div class="stepper" id="stepper">';
    FLOW.forEach((s, i) => {
      const cls = off ? '' : i < idx ? 'past' : i === idx ? 'current' : '';
      html += '<button class="step ' + cls + '" data-status="' + esc(s) + '"><span class="dot">' + (i < idx && !off ? '✓' : i + 1) +
        '</span><span class="lbl">' + esc(shortStatus(s)) + '</span></button>';
    });
    html += '</div>';
    html += '<div class="actions"><button class="btn" id="follow">⏰ ตั้งวันตาม</button><button class="btn" id="reprint">🖨️ พิมพ์ป้ายซ้ำ</button>' +
      '<a class="btn" href="#part-new/' + noDigits(j.no) + '">🔧 ถอดอะไหล่ให้งานนี้</a>' +
      (j.status !== 'ยกเลิก' ? '<button class="btn danger" id="cancel">ยกเลิกงาน</button>' : '') + '</div>';
    html += '<div class="note-box"><textarea id="note" placeholder="บันทึกโน้ตลงไทม์ไลน์ เช่น โทรแล้วลูกค้าไม่รับ"></textarea>' +
      '<button class="btn primary" id="save-note">บันทึก</button></div>';

    // แยกแชทจริงกับสถานะ/การทำงาน (ผู้ใช้ 29 ต.ค. 2569): หน้าตาต่างกัน + กรองดูอย่างเดียวได้ (จำค่าไว้ในเครื่อง)
    const nChat = data.events.filter(ev => evType(ev) === 'chat').length;
    const tl = tlFilter();
    const seg = (k, l) => '<button class="seg' + (tl === k ? ' on' : '') + '" data-tl="' + k + '">' + l + '</button>';
    html += '<h3>ไทม์ไลน์</h3><div class="segs tl-filter">' + seg('all', 'ทั้งหมด') + seg('chat', '💬 แชท (' + nChat + ')') +
      seg('act', '📋 สถานะ/บันทึก (' + (data.events.length - nChat) + ')') + '</div>' +
      '<p class="muted small">💬 = ข้อความจริงในแชท (ชื่อคนส่ง + เวลาที่ส่ง) · แถวเทาเล็ก = ระบบ/คนตรวจทำกับงาน · ข้อความหรือรูปที่ไม่ใช่ของงานนี้ ติ๊กแล้วย้ายไปงานที่ถูก หรือเอาออกได้</p>' +
      '<ul class="timeline' + (tl === 'all' ? '' : ' only-' + tl) + '" id="tl">';
    data.events.forEach(ev => { html += eventHtml(ev); });
    html += '</ul><div class="bulk-spacer"></div>';
    $app.innerHTML = html;
    state.jobData = data;
    state.moveSel = new Set();
    drawMoveBar();
    $app.querySelectorAll('[data-move]').forEach(box => box.onchange = () => {
      if (box.checked) state.moveSel.add(box.dataset.move); else state.moveSel.delete(box.dataset.move);
      box.closest('li').classList.toggle('picked', box.checked);
      drawMoveBar();
    });

    $app.querySelectorAll('[data-tl]').forEach(b => b.onclick = () => {
      tlFilter(b.dataset.tl);
      $app.querySelectorAll('[data-tl]').forEach(x => x.classList.toggle('on', x === b));
      document.getElementById('tl').className = 'timeline' + (b.dataset.tl === 'all' ? '' : ' only-' + b.dataset.tl);
    });
    const cur = $app.querySelector('.step.current');
    if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest' });
    $app.querySelectorAll('.step').forEach(btn => btn.onclick = () => statusSheet(data, btn.dataset.status));
    document.getElementById('follow').onclick = () => followSheet(data);
    const cancel = document.getElementById('cancel');
    if (cancel) cancel.onclick = () => statusSheet(data, 'ยกเลิก');
    document.getElementById('rename').onclick = () => renameSheet(data);
    wireInfo(data);
    wireRepair(data);
    document.getElementById('reprint').onclick = e => reprintLabel(e.target, { no: data.job.no });
    document.getElementById('save-note').onclick = async e => {
      const note = document.getElementById('note').value.trim();
      if (!note) return;
      busy(e.target);
      await save(data.job.no, { note }, 'บันทึกโน้ตแล้ว');
    };
    loadThumbs();
    $app.querySelectorAll('[data-media]').forEach(el => el.onclick = () => openMedia({ msgId: el.dataset.media, type: el.dataset.mtype, full: el.dataset.full }));
    if (state.openRepair) { state.openRepair = false; repairSheet(data); }   // ลิงก์จากน้องจ๊อบหลังปิดงาน (?repair=1)
  }

  // ป้ายหลุด/หาย → เข้าคิวพิมพ์ใหม่ (พิมพ์เสร็จน้องจ๊อบทักบอกคนที่กด)
  async function reprintLabel(btn, ref) {
    busy(btn);
    try {
      const out = await core('reprint', ref);
      toast(out.already ? 'ป้ายนี้อยู่ในคิวพิมพ์แล้ว รอสักครู่ 🖨️' : 'ส่งไปพิมพ์ป้ายแล้ว พิมพ์เสร็จจ๊อบจะทักบอกในแชท 🖨️');
    } catch (err) { if (err.message !== 'login') toast('⚠️ ' + err.message); }
    unbusy();
  }

  // ---------- ดูรูปเต็ม / เล่นคลิป / ดาวน์โหลด ----------
  // ref: { msgId } รูป/คลิปในกลุ่ม · { key } ไฟล์จากฟอร์ม/แชท · full = ลิงก์ที่รู้อยู่แล้ว
  // สำเนาบน Cloudflare เกิน 30 วันถูกลบ → ขอ Mac ดึงคืนจาก NAS แล้วรอ (เช็กทุก 3 วินาที ไม่เกิน ~90 วินาที)
  async function openMedia(ref) {
    const { type, full } = ref;
    const v = document.getElementById('viewer') || Object.assign(document.createElement('div'), { id: 'viewer', className: 'viewer' });
    document.body.appendChild(v);
    v.hidden = false;
    v.innerHTML = '<div class="viewer-bar"><button class="btn" id="v-close">✕ ปิด</button><button class="btn primary" id="v-dl" disabled>⬇️ ดาวน์โหลด</button></div>' +
      '<div class="viewer-body"><div class="center muted">กำลังโหลด…</div></div>';
    const close = () => { v.hidden = true; v.innerHTML = ''; };
    v.querySelector('#v-close').onclick = close;
    let m = full ? { url: full, download: full + '?dl=1' } : null;
    const body = v.querySelector('.viewer-body');
    const ask = () => core('media', ref.key ? { key: ref.key } : { msgId: ref.msgId });
    try {
      if (!m) m = await ask();
      for (let i = 0; m.restoring && i < 30; i++) {
        if (v.hidden) return; // ปิดหน้าต่างไปแล้ว
        body.innerHTML = '<div class="center"><p>⏳ ไฟล์นี้เก่ากว่า 1 เดือน กำลังดึงจาก NAS…</p>' +
          (m.alive ? '<p class="muted small">ปกติไม่เกิน 30 วินาที</p>' : '<p class="muted small">⚠️ เครื่อง Mac ที่ต่อ NAS ไม่ได้ออนไลน์ตอนนี้ ระบบจะดึงให้เมื่อเครื่องเปิด ปิดหน้านี้แล้วกลับมาดูใหม่ได้</p>') + '</div>';
        await new Promise(r => setTimeout(r, 3000));
        m = await ask();
      }
      if (m.restoring) { body.innerHTML = '<div class="center"><p>⏳ ยังดึงจาก NAS ไม่เสร็จ ลองเปิดใหม่ภายหลังครับ</p></div>'; return; }
    } catch (err) {
      if (err.message === 'login') return close();
      body.innerHTML = '<div class="center"><p>⚠️ ' + esc(err.message) + '</p></div>';
      return;
    }
    if (type === 'image') {
      body.innerHTML = '<img src="' + esc(m.url) + '" alt="รูปเต็ม"><div class="viewer-hint">แตะรูปเพื่อขยายขนาดจริง / ย่อกลับ</div>';
      const img = body.querySelector('img');
      img.onclick = () => body.classList.toggle('zoom');
      const jm = location.hash.match(/^#job\/(\d+)/);
      if (jm) { // รูปในหน้างาน → ใช้เป็นรูปตัวอย่างของสินค้า (หน้า "สินค้า")
        const star = Object.assign(document.createElement('button'), { className: 'btn', textContent: '⭐ ใช้เป็นรูปตัวอย่างสินค้า' });
        v.querySelector('.viewer-bar').insertBefore(star, v.querySelector('#v-dl'));
        star.onclick = () => refPickSheet(ref.key ? { key: ref.key, job: '#' + jm[1].padStart(4, '0') } : { msgId: ref.msgId, job: '#' + jm[1].padStart(4, '0') });
      }
    } else if (type === 'video') {
      body.innerHTML = '<video src="' + esc(m.url) + '" controls playsinline autoplay></video>';
    } else {
      body.innerHTML = '<div class="center"><p>📎 ' + esc(m.name || 'ไฟล์') + '</p><p class="muted small">กดดาวน์โหลดด้านบน</p></div>';
    }
    const dl = v.querySelector('#v-dl');
    dl.disabled = false;
    // ใน LINE เปิดลิงก์ดาวน์โหลดด้วยเบราว์เซอร์ของเครื่อง (บันทึกลงเครื่อง/แชร์ได้)
    dl.onclick = () => { if (window.liff && liff.isInClient && liff.isInClient()) liff.openWindow({ url: m.download, external: true }); else window.open(m.download, '_blank'); };
  }

  // ไทม์ไลน์: chat = ข้อความจริงจากแชท · note = โน้ต/สรุปที่คนเขียน · act = ระบบ/คนตรวจทำกับงาน (แถวเทาเล็ก)
  const NOTE_KINDS = ['โน้ต', 'สรุปการแก้ไข'];
  const ACT_ICON = { 'เปลี่ยนสถานะ': '🔄', 'เปิดงาน': '🆕', 'แนบข้อความ': '📎', 'รับข้อความ': '📎', 'ย้ายออก': '↪️', 'ย้ายข้อความ': '↪️', 'รวมงาน': '🔗',
    'AI เติมข้อมูลงาน': '🤖', 'แก้ชื่องาน': '✏️', 'แก้ข้อมูลงาน': '✏️', 'เอาออก': '🗑', 'เอาข้อความออก': '🗑', 'ตั้งวันตาม': '⏰', 'แยกงาน': '✂️', 'แยกข้อความ': '✂️', 'เพิ่มรูป': '🖼' };
  const evType = ev => ev.msg ? 'chat' : NOTE_KINDS.includes(ev.kind) ? 'note' : 'act';
  function tlFilter(set) {
    try { if (set) localStorage.setItem('tlFilter', set); return localStorage.getItem('tlFilter') || 'all'; } catch { return set || 'all'; }
  }

  function eventHtml(ev) {
    const type = evType(ev);
    if (type === 'act') {
      // แนบข้อความ = เวลาที่คนตรวจกด ไม่ใช่เวลาคุย → บอกให้ชัด
      const when = ev.kind === 'แนบข้อความ' ? 'ตรวจเมื่อ ' + fmtDateTime(ev.time) : fmtDateTime(ev.time);
      return '<li class="ev-act' + (ev.kind === 'เปลี่ยนสถานะ' ? ' k-status' : ev.kind === 'เปิดงาน' ? ' k-open' : '') + '"><div class="act-line">' + (ACT_ICON[ev.kind] || '⚙️') + ' <b>' + esc(ev.kind) + '</b>' +
        (ev.detail ? ' <span class="act-detail">' + esc(ev.detail) + '</span>' : '') + '</div><div class="act-meta">' + esc(ev.by || 'ระบบ') + ' · ' + esc(when) +
        (ev.job && ev.job !== (state.currentJob || ev.job) ? ' · ' + esc(ev.job) : '') + '</div></li>';
    }
    let body = '';
    if (ev.msg) {
      body += '<div class="what">💬 ' + esc(ev.msg.sender) + '</div>';
      if (ev.msg.type === 'text') body += '<div class="text">' + esc(ev.msg.text) + '</div>';
    } else {
      body += '<div class="what">📝 ' + esc(ev.kind) + ' <span class="muted small">โดย ' + esc(ev.by) + '</span></div>';
      if (ev.detail) body += '<div class="text">' + esc(ev.detail) + '</div>';
    }
    const kindClass = type === 'chat' ? 'ev-chat' : 'ev-note' + (ev.kind === 'สรุปการแก้ไข' ? ' k-fix' : '');
    if (ev.media) {
      // แตะรูป/คลิป/ไฟล์ = เปิดไฟล์จริง (Worker เก็บไว้ใน R2) + ปุ่มดาวน์โหลด
      const tap = ' data-media="' + esc(ev.msgId) + '" data-mtype="' + esc(ev.media.type) + '" data-full="' + esc(ev.media.full || '') + '"';
      if (ev.media.type === 'image') {
        body += '<div class="media-tap"' + tap + '>' + (ev.media.thumb
          ? '<div class="thumb-ph" data-thumb="' + esc(ev.msgId) + '">กำลังโหลดรูป…</div>'
          : ev.media.full ? '<img class="thumb" loading="lazy" alt="รูป" src="' + esc(ev.media.full) + '">' : '<div class="thumb-ph">🖼️ รูป — แตะเพื่อดู</div>') +
          '<span class="media-hint">🔍 แตะดูรูปเต็ม</span></div>';
      } else {
        body += '<div class="media-tap"' + tap + '><div class="thumb-ph media-play">' + (ev.media.type === 'video' ? '▶️ คลิป — แตะเพื่อเล่น' : '📎 ไฟล์ — แตะเพื่อดาวน์โหลด') + '</div></div>';
      }
      if (!ev.media.path) body += '<div class="path">' + esc(ev.media.status) + '</div>';
    } else if (ev.msg && ev.msg.type !== 'text') {
      body += '<div class="muted small">[' + esc(ev.msg.type) + ']</div>';
    }
    const when = (ev.msg && ev.msg.time) || ev.time;
    const pick = ev.movable ? '<label class="pick-inline"><input type="checkbox" data-move="' + esc(ev.msgId) + '"></label>' : '';
    return '<li class="' + kindClass + '">' + pick + '<div class="when">' + esc(fmtDateTime(when)) +
      (ev.job && ev.job !== (state.currentJob || ev.job) ? ' · ' + esc(ev.job) : '') + '</div>' + body + '</li>';
  }

  // แถบล่างของหน้างาน: ย้าย / แยกเป็นงานใหม่ / เอาออก ข้อความที่ติ๊ก
  function drawMoveBar() {
    let bar = document.getElementById('movebar');
    const n = state.moveSel ? state.moveSel.size : 0;
    if (!n || !/^#job\//.test(location.hash)) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'movebar';
      bar.className = 'bulkbar';
      document.body.appendChild(bar);
    }
    bar.innerHTML = '<div class="bulk-row"><b>เลือก ' + n + ' ข้อความ/รูป</b><button class="icon-btn" id="mv-clear">ล้าง</button></div>' +
      '<div class="bulk-row actions"><button class="btn primary" id="mv-move">📎 ย้ายไปงานอื่น…</button>' +
      '<button class="btn" id="mv-new">＋ แยกเป็นงานใหม่</button><button class="btn danger" id="mv-remove">🗑 เอาออกจากงานนี้</button></div>';
    bar.querySelector('#mv-clear').onclick = () => drawJob(state.jobData);
    bar.querySelector('#mv-move').onclick = () => sheet('<h2>ย้าย ' + n + ' ข้อความ/รูป ไปงานอื่น</h2>' +
      '<label class="field">เลขงานที่ถูกต้อง<input id="f-job" inputmode="numeric" placeholder="เช่น 131"></label>' +
      '<p class="muted small">หาเลขงานไม่เจอ? ปิดหน้านี้แล้วค้นในบอร์ดงานก่อน</p>' +
      '<div class="actions"><button class="btn primary" id="f-ok">ย้าย</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      el.querySelector('#f-ok').onclick = e => {
        const to = el.querySelector('#f-job').value.trim();
        if (!to) { toast('ใส่เลขงานก่อน'); return; }
        busy(e.target);
        moveMsgs({ to });
      };
    });
    bar.querySelector('#mv-new').onclick = () => sheet('<h2>แยก ' + n + ' ข้อความ/รูป เป็นงานใหม่</h2>' +
      '<label class="field">ชื่องาน (ลูกค้า + เครื่อง/อาการ)<input id="f-title" maxlength="120"></label>' +
      '<label class="field">สถานะ<select id="f-status">' + statusOptions(state.jobData.statuses, 'รับแจ้ง', false, true) + '</select></label>' +
      '<div class="actions"><button class="btn primary" id="f-ok">เปิดงานใหม่</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      el.querySelector('#f-ok').onclick = e => {
        const title = el.querySelector('#f-title').value.trim();
        if (!title) { toast('ใส่ชื่องานก่อน'); return; }
        busy(e.target);
        moveMsgs({ to: 'new', title, status: el.querySelector('#f-status').value });
      };
    });
    bar.querySelector('#mv-remove').onclick = () => sheet('<h2>เอา ' + n + ' ข้อความ/รูป ออกจากงานนี้?</h2>' +
      '<p class="muted small">ใช้เมื่อไม่เกี่ยวกับงานไหนเลย (ถ้าเป็นของงานอื่น ให้ใช้ “ย้ายไปงานอื่น”) · ประวัติยังเก็บไว้ในไทม์ไลน์</p>' +
      '<div class="actions"><button class="btn danger" id="f-ok">เอาออก</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      el.querySelector('#f-ok').onclick = e => { busy(e.target); moveMsgs({ to: '' }); };
    });
  }

  async function moveMsgs(choice) {
    try {
      const data = await api('moveMsgs', Object.assign({ no: state.jobData.job.no, msgIds: Array.from(state.moveSel) }, choice));
      closeSheet();
      drawJob(data);
      toast(data.moved.to ? 'ย้าย ' + data.moved.count + ' รายการไป ' + data.moved.label + ' ✅' : 'เอาออก ' + data.moved.count + ' รายการแล้ว ✅');
    } catch (err) {
      if (err.message !== 'login') toast('⚠️ ' + err.message);
      unbusy();
    }
  }

  function loadThumbs() {
    const nodes = $app.querySelectorAll('[data-thumb]');
    if (!nodes.length) return;
    const show = async node => {
      const id = node.dataset.thumb;
      try {
        if (!state.thumbs[id]) state.thumbs[id] = (await api('thumb', { msgId: id })).src;
        const img = document.createElement('img');
        img.className = 'thumb';
        img.alt = 'รูป';
        img.src = state.thumbs[id];
        node.replaceWith(img);
      } catch (err) {
        node.textContent = 'โหลดรูปไม่ได้';
      }
    };
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      if (e.isIntersecting) { io.unobserve(e.target); show(e.target); }
    }), { rootMargin: '200px' });
    nodes.forEach(n => io.observe(n));
  }

  function busy(btn) {
    if (!btn) return;
    btn.disabled = true;
    btn.dataset.label = btn.textContent;
    btn.textContent = 'กำลังบันทึก…';
  }
  function unbusy() {
    document.querySelectorAll('button[data-label]').forEach(b => {
      b.disabled = false;
      b.textContent = b.dataset.label;
      delete b.dataset.label;
    });
  }

  async function save(no, changes, okMsg) {
    const before = state.jobData;
    // แสดงผลทันที (ไม่ต้องรอระบบ 3–5 วินาที) แล้วค่อยแทนด้วยข้อมูลจริงเมื่อบันทึกเสร็จ
    if (before && before.job.no === no) {
      const local = JSON.parse(JSON.stringify(before));
      const me = (state.me && state.me.name ? state.me.name : 'คุณ') + ' (เว็บ)';
      const now = new Date().toISOString();
      if (changes.status) {
        local.events.push({ time: now, by: me, kind: 'เปลี่ยนสถานะ', detail: local.job.status + ' → ' + changes.status + ' (กำลังบันทึก…)' });
        local.job.status = changes.status;
        local.job.closed = ['ปิด', 'ยกเลิก'].indexOf(changes.status) >= 0;
      }
      if (changes.follow) local.job.follow = changes.follow;
      if (changes.title) local.job.title = changes.title;
      if (changes.note) local.events.push({ time: now, by: me, kind: changes.status === 'ปิด' ? 'สรุปการแก้ไข' : 'โน้ต', detail: changes.note + ' (กำลังบันทึก…)' });
      closeSheet();
      drawJob(local);
      state.jobData = before; // ข้อมูลจริงยังเป็นของเดิมจนกว่าระบบตอบ
    }
    try {
      const data = await api('update', Object.assign({ no }, changes));
      closeSheet();
      if (/^#job\//.test(location.hash)) drawJob(data);
      if (changes.status === 'ปิด') { // ป๊อปอัปปิดงาน (ผู้ใช้ 26 ต.ค. 2569) · น้องจ๊อบทักคนปิดในแชทด้วย
        sheet('<div class="created-pop"><div class="pop-ok">✅</div><h2>ปิดงานแล้ว</h2><div class="big-no">' + esc(no) + '</div>' +
          '<p>ขอบคุณครับ 🙏</p><p class="muted small">น้องจ๊อบส่งสรุปไว้ในแชทให้แล้ว</p>' +
          '<p><b>ต่ออีกนิด: สรุปการซ่อม</b><br><span class="muted small">ใส่รูป/พูดเล่าว่าเสียตรงไหน เพราะอะไร AI สรุปเป็นหัวข้อ เก็บเป็นประวัติของรุ่นนี้</span></p>' +
          '<div class="actions"><button class="btn primary" id="f-repair">📋 สรุปการซ่อมเลย</button><button class="btn" data-close>ไว้ทีหลัง</button></div></div>',
          el => { el.querySelector('#f-repair').onclick = () => repairSheet(data, changes.note); });
      } else toast(okMsg + ' ✅');
    } catch (err) {
      if (err.message !== 'login') toast('⚠️ บันทึกไม่สำเร็จ: ' + err.message);
      if (before && /^#job\//.test(location.hash)) drawJob(before);
      unbusy();
    }
  }

  // ปิดงานต้องมีสรุปการแก้ไข (Apps Script บังคับอีกชั้น) · พิมพ์ หรือกดไมค์บนคีย์บอร์ดมือถือพูดแทนพิมพ์
  const FIX_NOTE_MIN = 10;
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  function fixNoteField() {
    return '<label class="field"><span class="lbl">สรุปการแก้ไข <b class="req">*</b></span>' +
      '<textarea id="f-note" rows="4" maxlength="1000" placeholder="ทำอะไรไปบ้าง เช่น เปลี่ยนซีลปั๊มไฮดรอลิก เติมน้ำมัน ทดสอบยก 10 นาทีไม่รั่ว"></textarea></label>' +
      (Speech ? '<button type="button" class="btn" id="mic">🎤 กดแล้วพูด</button>' : '') +
      '<p class="muted small">พูดแทนพิมพ์ได้: แตะช่องข้างบน แล้วกดรูปไมค์ 🎤 บนคีย์บอร์ดมือถือ</p>';
  }
  function wireMic(el) {
    const btn = el.querySelector('#mic');
    if (!btn) return;
    let rec = null;
    btn.onclick = () => {
      if (rec) { rec.stop(); return; }
      rec = new Speech();
      rec.lang = 'th-TH'; rec.interimResults = false; rec.continuous = true;
      const box = el.querySelector('#f-note');
      rec.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) box.value = (box.value + ' ' + e.results[i][0].transcript).trim(); };
      rec.onerror = () => toast('ใช้ไมค์ในหน้านี้ไม่ได้ ใช้ไมค์บนคีย์บอร์ดแทน');
      rec.onend = () => { rec = null; btn.textContent = '🎤 กดแล้วพูด'; };
      try { rec.start(); btn.textContent = '⏹ หยุดฟัง'; } catch (err) { rec = null; toast('ใช้ไมค์ในหน้านี้ไม่ได้ ใช้ไมค์บนคีย์บอร์ดแทน'); }
    };
  }

  function statusSheet(data, status) {
    const waiting = data.waitingCustomer.indexOf(status) >= 0;
    const closing = status === 'ปิด' && data.job.status !== 'ปิด';
    const miss = closing ? (data.closeMissing || []) : [];
    if (miss.length) { // ปิดงานต้องมี รูป อาการ ชื่อลูกค้า เบอร์ ครบก่อน (Worker ตรวจซ้ำ)
      return sheet('<h2>ยังปิดงานไม่ได้</h2><p>ต้องเติมข้อมูลให้ครบก่อน: <b>' + esc(miss.join(', ')) + '</b></p>' +
        '<div class="actions">' + (miss.some(m => m !== 'รูป') ? '<button class="btn primary" id="f-fill">✏️ เติมข้อมูลงาน</button>' : '') +
        (miss.includes('รูป') ? '<button class="btn' + (miss.length === 1 ? ' primary' : '') + '" id="f-photo">📷 เพิ่มรูป</button>' : '') +
        '<button class="btn" data-close>ปิด</button></div>', el => {
        const f = el.querySelector('#f-fill'); if (f) f.onclick = () => infoSheet(data, true);
        const ph = el.querySelector('#f-photo'); if (ph) ph.onclick = () => { closeSheet(); document.getElementById('info-pick').click(); };
      });
    }
    const html = '<h2>เปลี่ยนเป็น “' + esc(status) + '”</h2>' +
      '<p class="muted small">' + esc(data.job.no) + ' ' + esc(data.job.title) + ' · ตอนนี้: ' + esc(data.job.status) + '</p>' +
      (status === 'ปิด' || status === 'ยกเลิก' ? '' :
        '<label class="field">วันที่ต้องตามต่อ' + (waiting ? ' (รอลูกค้า ต้องมีวันตาม)' : ' (ไม่บังคับ)') +
        '<input type="date" id="f-date" min="' + todayKey() + '" value="' + (waiting ? nextBusinessKey() : '') + '"></label>') +
      (closing ? fixNoteField() : '<label class="field">โน้ต (ไม่บังคับ)<textarea id="f-note" rows="2"></textarea></label>') +
      '<div class="actions"><button class="btn primary" id="f-ok">' + (closing ? 'ปิดงาน' : 'บันทึก') + '</button><button class="btn" data-close>ยกเลิก</button></div>';
    sheet(html, el => {
      if (closing) wireMic(el);
      el.querySelector('#f-ok').onclick = async e => {
        const fix = el.querySelector('#f-note').value.trim();
        if (closing && fix.length < FIX_NOTE_MIN) { toast('ใส่สรุปการแก้ไขก่อนปิดงาน (อย่างน้อย ' + FIX_NOTE_MIN + ' ตัวอักษร)'); el.querySelector('#f-note').focus(); return; }
        busy(e.target);
        const date = el.querySelector('#f-date');
        await save(data.job.no, { status, follow: date ? date.value : '', note: el.querySelector('#f-note').value.trim() },
          data.job.no + ' → ' + status);
      };
    });
  }

  // ---------- สรุปการซ่อม (ผู้ใช้ 31 ต.ค. 2569): รูป/คลิป + พูดเล่า → AI สรุปเป็นหัวข้อ ถามต่อถ้าสาเหตุไม่ชัด → คนแก้/ยืนยัน ----------
  // เก็บเป็นประวัติการเสียต่อรุ่น (วิเคราะห์จุดอ่อนสินค้า → R&D) · ใครในทีมก็สรุปได้ · ปิดงานแล้วเด้งมาให้ทำต่อ
  const REPAIR_ROWS = [['system', '⚙️ ระบบที่เสีย'], ['part', '🔩 ชิ้นส่วนที่เสีย'], ['symptom', '🩺 อาการ'], ['cause_type', '🏷️ ประเภทสาเหตุ'], ['cause', '🔍 สาเหตุ'],
    ['fix', '🛠️ วิธีแก้'], ['parts_used', '📦 อะไหล่ที่เปลี่ยน'], ['test', '✅ ทดสอบหลังซ่อม'], ['prevent', '💡 ข้อเสนอป้องกัน/ปรับปรุง']];
  const UNKNOWN_RE = /^(ไม่ทราบ|ยังไม่ทราบ)$/;
  function repairView(r) {
    let h = '<div class="repair-view">' + (r.summary ? '<p class="repair-sum">' + esc(r.summary) + '</p>' : '');
    if (r.product || r.serial) h += '<div class="info-row"><span class="muted">สินค้า</span><span>' + esc([r.product, r.serial && 'SN ' + r.serial].filter(Boolean).join(' · ')) + '</span></div>';
    REPAIR_ROWS.forEach(([k, label]) => {
      if (!r[k]) return;
      h += '<div class="repair-row"><span class="muted">' + label + '</span><span' + (UNKNOWN_RE.test(r[k]) ? ' class="muted"' : '') + '>' + esc(r[k]) + '</span></div>';
    });
    return h + '</div>';
  }
  function repairHtml(data) {
    const j = data.job, r = data.repair;
    if (j.status === 'ยกเลิก' || j.status === 'รวมกับงานอื่น') return '';
    let h = '<div class="panel-box repair-box' + (j.closed && !(r && r.state === 'ยืนยันแล้ว') ? ' need' : '') + '"><div class="row"><b>📋 สรุปการซ่อม</b>';
    if (r && r.state === 'ยืนยันแล้ว') {
      return h + '<button class="btn" id="repair-go">✏️ แก้</button></div>' + repairView(r) +
        '<div class="muted small">ยืนยันโดย ' + esc(r.confirmedBy) + ' · ' + esc(fmtDate(r.confirmedAt)) + '</div></div>';
    }
    return h + '</div><p class="muted small">' + (r ? 'มีร่างค้างไว้ (' + esc(r.state) + ') กดทำต่อได้'
      : j.closed ? '⚠️ งานปิดแล้วแต่ยังไม่มีสรุปการซ่อม — ใครในทีมก็สรุปได้'
      : 'ซ่อมเสร็จแล้ว ใส่รูป/คลิป แล้วพูดเล่าว่าเสียตรงไหน เพราะอะไร แก้อย่างไร AI สรุปเป็นหัวข้อให้') + '</p>' +
      '<button class="btn primary" id="repair-go">📋 ' + (r ? 'ทำสรุปต่อ' : 'สรุปการซ่อม') + '</button></div>';
  }
  function wireRepair(data) {
    const b = document.getElementById('repair-go');
    if (b) b.onclick = () => repairSheet(data);
  }

  /** เปิดหน้าต่างสรุป: มีคำถามค้าง → ตอบ · มีร่าง → ตรวจ/แก้ · ไม่มี → เล่า (note = ข้อความตั้งต้น เช่น สรุปการแก้ไขตอนปิด) */
  function repairSheet(data, note) {
    const r = data.repair;
    if (r && r.state === 'ถามต่อ' && r.questions.length) return repairAsk(data);
    if (r && !note) return repairEdit(data);
    repairTell(data, note || '');
  }

  async function repairRun(data, payload) {
    sheet('<div class="center"><div class="pop-ok">🤖</div><p>AI กำลังอ่านแชท โน้ต และรูปของงานนี้…</p><p class="muted small">ประมาณ 10–30 วินาที</p></div>');
    try {
      const out = await core('repairDraft', Object.assign({ no: data.job.no }, payload), 60000);
      data.repair = out.report;
      if (state.jobData && state.jobData.job.no === data.job.no && /^#job\//.test(location.hash)) { state.jobData.repair = out.report; drawJob(state.jobData); }
      repairSheet(data);
    } catch (err) {
      if (err.message === 'login') return;
      toast('⚠️ ' + err.message);
      if (data.repair) repairSheet(data); else closeSheet();
    }
  }

  function repairTell(data, note) {
    const keys = [];
    sheet('<h2>📋 สรุปการซ่อม ' + esc(data.job.no) + '</h2>' +
      '<p class="muted small">เล่าให้ครบ: <b>เสียตรงไหน · เพราะอะไร · แก้อย่างไร · เปลี่ยนอะไหล่อะไร · ทดสอบแล้วเป็นอย่างไร</b><br>AI อ่านแชทและโน้ตในงานนี้ด้วย ไม่ต้องเล่าซ้ำเรื่องที่คุยไว้แล้ว</p>' +
      '<div class="row-gap"><label class="btn"><input type="file" id="r-pick" accept="image/*,video/*" multiple hidden>📷 รูป / คลิปจุดที่เสีย</label><span id="r-files" class="muted small"></span></div>' +
      '<label class="field"><span class="lbl">เล่าการซ่อม</span><textarea id="f-note" rows="5" maxlength="2000" placeholder="เช่น สายคันเร่งขาดตรงข้อพับ เพราะเสียดสีกับขอบเหล็ก เปลี่ยนสายใหม่ ใส่ปลอกยางกัน ลองเร่งเครื่อง 10 นาทีปกติ">' + esc(note) + '</textarea></label>' +
      (Speech ? '<button type="button" class="btn" id="mic">🎤 กดแล้วพูด</button>' : '') +
      '<p class="muted small">พูดแทนพิมพ์ได้: แตะช่องข้างบน แล้วกดรูปไมค์ 🎤 บนคีย์บอร์ดมือถือ</p>' +
      '<div class="actions"><button class="btn primary" id="r-go">🤖 ให้ AI สรุป</button>' + (data.repair ? '<button class="btn" id="r-back">‹ กลับไปร่าง</button>' : '') +
      '<button class="btn" data-close>ไว้ทีหลัง</button></div>', el => {
      wireMic(el);
      const info = el.querySelector('#r-files');
      let uploading = 0;
      el.querySelector('#r-pick').onchange = async e => {
        const picked = [...e.target.files];
        e.target.value = '';
        uploading += picked.length;
        info.textContent = 'กำลังส่ง ' + picked.length + ' ไฟล์…';
        for (const f of picked) {
          try { keys.push(await uploadFile(f)); } catch (err) { if (err.message !== 'login') toast('⚠️ ' + err.message); }
          uploading--;
        }
        info.textContent = keys.length ? '✅ ' + keys.length + ' ไฟล์' : '';
      };
      const back = el.querySelector('#r-back');
      if (back) back.onclick = () => repairEdit(data);
      el.querySelector('#r-go').onclick = () => {
        if (uploading) return toast('รอส่งรูป/คลิปให้เสร็จก่อน');
        const text = el.querySelector('#f-note').value.trim();
        if (!text && !keys.length && !data.repair) { toast('เล่าการซ่อม หรือใส่รูปก่อน'); el.querySelector('#f-note').focus(); return; }
        repairRun(data, { note: text, files: keys });
      };
    });
  }

  function repairAsk(data) {
    const qs = data.repair.questions;
    sheet('<h2>🤖 AI ขอถามเพิ่ม</h2><p class="muted small">ตอบเท่าที่รู้ (พิมพ์หรือพูด) ข้อไหนไม่รู้เว้นไว้ได้</p>' +
      qs.map((q, i) => '<label class="field"><span class="lbl">' + (i + 1) + '. ' + esc(q) + '</span><textarea data-ans="' + i + '" rows="2" maxlength="800"></textarea></label>' +
        (SPEECH ? '<button type="button" class="btn mic" data-micfor="' + i + '">🎤 พูด</button>' : '')).join('') +
      '<div class="actions"><button class="btn primary" id="r-go">ตอบแล้วสรุป</button><button class="btn" id="r-final">ไม่รู้ สรุปเลย</button>' +
      '<button class="btn" data-close>ไว้ทีหลัง</button></div>', el => {
      el.querySelectorAll('[data-micfor]').forEach(b => b.onclick = () => listen(b, el.querySelector('[data-ans="' + b.dataset.micfor + '"]')));
      const answers = () => qs.map((q, i) => el.querySelector('[data-ans="' + i + '"]').value.trim());
      el.querySelector('#r-go').onclick = () => {
        const a = answers();
        if (!a.some(Boolean)) return toast('ยังไม่ได้ตอบ — ไม่รู้กด "ไม่รู้ สรุปเลย"');
        repairRun(data, { answers: a });
      };
      el.querySelector('#r-final').onclick = () => repairRun(data, { answers: answers(), final: true });
    });
  }

  function repairEdit(data) {
    const r = data.repair, opts = data.repairOpts || { systems: [], causes: [] };
    const sel = (k, list) => '<select data-rk="' + k + '">' + list.map(v => '<option' + (v === r[k] ? ' selected' : '') + '>' + esc(v) + '</option>').join('') + '</select>';
    const area = (k, rows) => '<textarea data-rk="' + k + '" rows="' + rows + '">' + esc(r[k]) + '</textarea>';
    const fld = (label, inner) => '<label class="field"><span class="lbl">' + label + '</span>' + inner + '</label>';
    sheet('<h2>📋 ตรวจสรุปการซ่อม ' + esc(data.job.no) + '</h2><p class="muted small">AI สรุปให้แล้ว แก้ช่องที่ไม่ถูกได้เลย แล้วกดยืนยัน</p>' +
      fld('สรุปสั้น', area('summary', 2)) +
      fld('สินค้า/รุ่น', '<input data-rk="product" value="' + esc(r.product) + '">') + fld('SN', '<input data-rk="serial" value="' + esc(r.serial) + '">') +
      REPAIR_ROWS.map(([k, label]) => fld(label, k === 'system' ? sel(k, opts.systems) : k === 'cause_type' ? sel(k, opts.causes) : area(k, ['cause', 'fix', 'prevent'].includes(k) ? 3 : 2))).join('') +
      '<div class="actions"><button class="btn primary" id="r-ok">✅ ยืนยันสรุป</button><button class="btn" id="r-more">🗣️ เล่าเพิ่ม ให้ AI สรุปใหม่</button>' +
      '<button class="btn" data-close>ไว้ทีหลัง</button></div>', el => {
      el.querySelector('#r-more').onclick = () => repairTell(data, '');
      el.querySelector('#r-ok').onclick = async e => {
        const report = {};
        el.querySelectorAll('[data-rk]').forEach(x => { report[x.dataset.rk] = x.value.trim(); });
        if (!report.part && !report.fix) return toast('ใส่ชิ้นส่วนที่เสีย หรือวิธีแก้ อย่างน้อย 1 ช่อง');
        busy(e.target);
        try {
          const out = await core('repairSave', { no: data.job.no, report });
          data.repair = out.report;
          closeSheet();
          if (state.jobData && state.jobData.job.no === data.job.no && /^#job\//.test(location.hash)) {
            state.jobData.repair = out.report;
            const page = await api('job', { no: data.job.no });   // แถว "สรุปการซ่อม" ในไทม์ไลน์
            if (/^#job\//.test(location.hash)) drawJob(page);
          }
          toast('บันทึกสรุปการซ่อมแล้ว ✅ ขอบคุณครับ');
        } catch (err) { if (err.message !== 'login') toast('⚠️ ' + err.message); unbusy(); }
      };
    });
  }

  // ---------- ข้อมูลงาน: เปิดงานเร็วแล้วเติม/แก้ทีหลัง (สแกน QR ที่ป้ายเข้าหน้านี้) · ปิดงานต้องมี รูป อาการ ชื่อลูกค้า เบอร์ ----------
  const INFO_ROWS = [['customer', 'ลูกค้า'], ['phone', 'เบอร์'], ['product', 'สินค้า'], ['serial', 'SN'], ['symptom', 'อาการ'], ['address', 'ที่อยู่'], ['province', 'จังหวัด']];
  function infoHtml(data) {
    const i = data.info;
    if (!i) return '';
    const miss = data.job.closed ? [] : (data.closeMissing || []);
    let h = '<div class="panel-box info-box"><div class="row"><b>ข้อมูลงาน</b><button class="btn" id="info-edit">✏️ แก้ข้อมูลงาน</button></div>';
    INFO_ROWS.forEach(([k, label]) => {
      const v = k === 'phone' && i.phone ? fmtPhoneTh(i.phone) : i[k];
      h += '<div class="info-row"><span class="muted">' + label + '</span><span' + (v ? '' : ' class="muted"') + '>' + esc(v || '—') + '</span></div>';
    });
    const files = data.files || [];
    h += '<div class="info-row"><span class="muted">รูป/คลิป</span><span>' + i.photos + ' ไฟล์</span></div>';
    if (files.length) h += '<div class="files">' + files.map(f => '<div class="file" data-fkey="' + esc(f.key) + '" data-ftype="' + f.type + '" data-furl="' + esc(f.url) + '">' +
      (f.type === 'image' ? '<img loading="lazy" src="' + esc(f.url) + '" alt="">' : '<div class="vid">🎬</div>') + '</div>').join('') + '</div>';
    h += '<label class="btn"><input type="file" id="info-pick" accept="image/*,video/*" multiple hidden>📷 เพิ่มรูป / คลิป</label>';
    if (miss.length) h += '<div class="flag-due small">📝 ก่อนปิดงานต้องเติม: ' + esc(miss.join(', ')) + '</div>';
    return h + '</div>';
  }
  const fmtPhoneTh = d => d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : d;
  function wireInfo(data) {
    const edit = document.getElementById('info-edit');
    if (!edit) return;
    edit.onclick = () => infoSheet(data);
    $app.querySelectorAll('[data-fkey]').forEach(el => el.onclick = () => openMedia({ key: el.dataset.fkey, type: el.dataset.ftype, full: el.dataset.furl }));
    document.getElementById('info-pick').onchange = async e => {
      const picked = [...e.target.files];
      e.target.value = '';
      if (!picked.length) return;
      toast('กำลังส่งรูป ' + picked.length + ' ไฟล์…');
      try {
        const keys = [];
        for (const f of picked) keys.push(await uploadFile(f));
        toast('🤖 AI กำลังอ่านรูป เติมข้อมูลงาน…');
        const out = await core('addFiles', { no: data.job.no, files: keys });
        if (/^#job\//.test(location.hash)) drawJob(out);
        toast('เพิ่มรูปเข้างานแล้ว ✅' + aiNote(out.ai) + (out.aiDoubt ? ' · ⚠️ ' + out.aiDoubt : ''));
      } catch (err) { if (err.message !== 'login') toast('⚠️ ' + err.message); }
    };
  }
  // ช่องที่ต้องมีก่อนปิดงาน (ตรงกับ closeMissing ใน Worker) · ผ่าน = ค่าที่กรอกใช้ได้
  const CLOSE_NEED = { customer: ['ชื่อลูกค้า', v => !!v.trim()], phone: ['เบอร์', v => v.replace(/\D/g, '').length >= 9], symptom: ['อาการ', v => !!v.trim()] };
  // closing = มาจากกดปิดงานแล้วข้อมูลไม่ครบ → บันทึกครบแล้วไปหน้าปิดงานต่อ
  function infoSheet(data, closing) {
    const i = data.info || {};
    const miss = data.job.closed ? [] : (data.closeMissing || []);
    const opt = (list, cur) => '<option value=""></option>' + list.map(p => '<option' + (p === cur ? ' selected' : '') + '>' + esc(p) + '</option>').join('');
    // ช่องที่ขาดก่อนปิด: กรอบแดง + ป้าย "ต้องกรอกก่อนปิดงาน" · กรอกถูกแล้วเปลี่ยนเป็นเขียว "✓ ได้แล้ว"
    const fld = (k, label, inner) => '<label class="field' + (CLOSE_NEED[k] && miss.includes(CLOSE_NEED[k][0]) ? ' need' : '') + '" data-k="' + k + '"><span class="lbl">' + label +
      (CLOSE_NEED[k] && miss.includes(CLOSE_NEED[k][0]) ? ' <span class="need-tag">ต้องกรอกก่อนปิดงาน</span>' : '') + '</span>' + inner + '</label>';
    sheet('<h2>แก้ข้อมูลงาน ' + esc(data.job.no) + '</h2>' +
      fld('customer', 'ชื่อลูกค้า / ร้าน', '<input id="i-customer" maxlength="80" value="' + esc(i.customer || '') + '">') +
      fld('phone', 'เบอร์ลูกค้า', '<input id="i-phone" type="tel" inputmode="tel" value="' + esc(i.phone || '') + '">') +
      fld('symptom', 'อาการ / สิ่งที่ลูกค้าแจ้ง', '<textarea id="i-symptom" rows="3" maxlength="300">' + esc(i.symptom || '') + '</textarea>') +
      fld('product', 'สินค้า / รุ่น', '<input id="i-product" list="plist2" maxlength="80" value="' + esc(i.product || '') + '"><datalist id="plist2">' +
        PRODUCT_HINTS.map(p => '<option value="' + esc(p) + '">').join('') + '</datalist>') +
      fld('serial', 'SN / เลขเครื่อง (ป้ายชำรุดพิมพ์ "ป้ายชำรุด")', '<input id="i-serial" maxlength="40" value="' + esc(i.serial || '') + '">') +
      fld('address', 'ที่อยู่', '<textarea id="i-address" rows="2" maxlength="200">' + esc(i.address || '') + '</textarea>') +
      fld('province', 'จังหวัด', '<select id="i-province">' + opt(PROVINCES, i.province) + '</select>') +
      '<div class="actions"><button class="btn primary" id="f-ok">บันทึก</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      el.querySelectorAll('.field.need').forEach(box => {
        const k = box.dataset.k, input = box.querySelector('#i-' + k), tag = box.querySelector('.need-tag');
        const check = () => {
          const ok = CLOSE_NEED[k][1](input.value);
          box.classList.toggle('ok', ok);
          tag.textContent = ok ? '✓ ได้แล้ว' : k === 'phone' && input.value.trim() ? 'เบอร์ยังไม่ครบ (อย่างน้อย 9 หลัก)' : 'ต้องกรอกก่อนปิดงาน';
        };
        input.addEventListener('input', check);
        check();
      });
      const first = el.querySelector('.field.need:not(.ok)');
      if (first) first.scrollIntoView({ block: 'center' });
      el.querySelector('#f-ok').onclick = async e => {
        const info = {};
        INFO_ROWS.forEach(([k]) => { info[k] = el.querySelector('#i-' + k).value.trim(); });
        if (info.phone && info.phone.replace(/\D/g, '').length < 9) return toast(CORE_ERRORS.bad_phone);
        busy(e.target);
        try {
          const out = await core('editInfo', { no: data.job.no, info });
          closeSheet();
          if (/^#job\//.test(location.hash)) drawJob(out);
          const left = out.closeMissing || [];
          if (closing && !left.length) return statusSheet(out, 'ปิด');   // ครบแล้ว → ใส่สรุปการแก้ไขแล้วปิดงานต่อได้เลย
          toast('บันทึกข้อมูลงานแล้ว ✅' + (closing && left.length ? ' · ยังขาด ' + left.join(', ') : ''));
        } catch (err) { if (err.message !== 'login') toast('⚠️ ' + err.message); unbusy(); }
      };
    });
  }

  function followSheet(data) {
    sheet('<h2>ตั้งวันตามต่อ</h2><label class="field">วันที่<input type="date" id="f-date" min="' + todayKey() + '" value="' +
      esc(data.job.follow || nextBusinessKey()) + '"></label><div class="actions"><button class="btn primary" id="f-ok">บันทึก</button>' +
      '<button class="btn" data-close>ยกเลิก</button></div>', el => {
      el.querySelector('#f-ok').onclick = async e => {
        busy(e.target);
        await save(data.job.no, { follow: el.querySelector('#f-date').value }, 'ตั้งวันตามแล้ว');
      };
    });
  }

  function renameSheet(data) {
    sheet('<h2>แก้ชื่องาน</h2><label class="field">ชื่องาน (ลูกค้า + เครื่อง/อาการ)<input id="f-title" maxlength="120" value="' +
      esc(data.job.title) + '"></label><div class="actions"><button class="btn primary" id="f-ok">บันทึก</button>' +
      '<button class="btn" data-close>ยกเลิก</button></div>', el => {
      el.querySelector('#f-ok').onclick = async e => {
        busy(e.target);
        await save(data.job.no, { title: el.querySelector('#f-title').value.trim() }, 'แก้ชื่องานแล้ว');
      };
    });
  }

  // ---------- คิวตรวจ ----------
  // แบ่ง 3 กลุ่ม · ติ๊กหลายข้อแล้วกดแถบด้านล่างทีเดียว
  const REVIEW_GROUPS = [
    ['need', 'ต้องตัดสิน (งานใหม่ / ไม่แน่ใจ)', it => it.action !== 'อัปเดตงานเดิม' && it.action !== 'ไม่เกี่ยวกับงาน'],
    ['attach', 'AI เสนอแนบเข้างานเดิม', it => it.action === 'อัปเดตงานเดิม'],
    ['notjob', 'AI คิดว่าไม่เกี่ยว (ไม่มั่นใจ)', it => it.action === 'ไม่เกี่ยวกับงาน']
  ];

  // โหมด: คิวตรวจ (เฉพาะข้อที่ต้องตัดสิน) · ไล่ตามแชท (ทุกก้อนของวัน รวมที่ AI ตัดออก เพื่อหางานที่ AI พลาด)
  async function renderReview() {
    setTab('review');
    const live = claim();
    state.reviewMode = state.reviewMode || 'queue';
    state.selected = new Set();
    $app.innerHTML = reviewHeader() + '<div class="center muted">กำลังโหลด…</div>';
    bindReviewHeader();
    if (state.reviewMode === 'chat') {
      state.chatDate = state.chatDate || todayKey();
      const chat = await api('chat', { date: state.chatDate });
      if (!live()) return;
      state.chat = chat;
      drawChat();
    } else {
      const review = await api('review');
      if (!live()) return;
      review.items = review.items.filter(x => !pendingRows.has(x.row));
      state.review = review;
      setBadge(state.review.items.length);
      drawReview();
    }
  }

  function reviewHeader() {
    const seg = (mode, label) => '<button class="seg' + (state.reviewMode === mode ? ' on' : '') + '" data-mode="' + mode + '">' + label + '</button>';
    let html = '<div class="review-head"><div class="segs">' + seg('queue', 'คิวตรวจ') + seg('chat', 'ไล่ตามแชท') +
      '</div><button class="btn" id="add-missed">＋ เพิ่มงานที่พลาด</button></div>';
    if (state.reviewMode === 'chat') {
      html += '<div class="datebar"><button class="btn" data-day="-1">‹</button><input type="date" id="chat-date" max="' + todayKey() +
        '" value="' + esc(state.chatDate || todayKey()) + '"><button class="btn" data-day="1">›</button></div>';
    }
    return html;
  }

  function bindReviewHeader() {
    $app.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
      if (state.reviewMode === b.dataset.mode) return;
      state.reviewMode = b.dataset.mode;
      renderReview().catch(showError);
    });
    document.getElementById('add-missed').onclick = () => missedSheet();
    const date = document.getElementById('chat-date');
    if (date) {
      date.onchange = () => { state.chatDate = date.value || todayKey(); renderReview().catch(showError); };
      $app.querySelectorAll('[data-day]').forEach(b => b.onclick = () => {
        const d = new Date(state.chatDate + 'T12:00:00');
        d.setDate(d.getDate() + Number(b.dataset.day));
        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        if (key > todayKey()) return;
        state.chatDate = key;
        renderReview().catch(showError);
      });
    }
  }

  function currentItems() {
    const src = state.reviewMode === 'chat' ? state.chat : state.review;
    return src ? src.items : [];
  }

  function drawChat() {
    const data = state.chat;
    let html = reviewHeader();
    if (!data.items.length) {
      html += '<div class="center muted">ยังไม่มีข้อความของวันนี้ที่ประมวลผลแล้ว<br><span class="small">(ข้อความล่าสุดใช้เวลาราว 10–15 นาที · ก่อน 8 ต.ค. ไม่มีข้อมูล)</span></div>';
    } else {
      html += '<p class="muted small">ทุกก้อนข้อความในกลุ่มหลัก ' + data.items.length + ' ก้อน เรียงตามเวลา · ติ๊กก้อนที่เป็นงานแล้วกดแถบด้านล่าง</p>';
      data.items.forEach(it => { html += chatHtml(it); });
    }
    $app.innerHTML = html + '<div class="bulk-spacer"></div>';
    bindReviewHeader();
    bindPicks();
    drawBulkBar();
  }

  // ก้อนที่บางข้อความอยู่ในงานแล้ว (เช่น ตอบกลับรูปของงานอื่น) · แนบ/เปิดงานจะเอาแค่ข้อความที่เหลือ
  const partialNote = labels => '<span class="muted small">📂 บางข้อความอยู่ใน ' + labels.map(esc).join(', ') + ' แล้ว (ไม่ย้าย)</span>';

  function chatHtml(it) {
    const done = !!(it.inJob || it.human);
    let badge;
    const aiDid = it.inJob && /^AI/.test(it.inJobBy || '');
    // AI แนบเอง (รูป/เบอร์/SN ตรงกัน): กดไปหน้างานเพื่อตรวจ ผิดก็ย้ายออกที่นั่น
    if (aiDid) badge = '<a class="tag tag-job tag-aidid" href="#job/' + esc(String(it.inJob).replace(/\D/g, '')) + '">🤖 AI แนบเข้า ' +
      esc(it.inJobLabel) + ' (' + esc(it.inJobBy.replace(/^AI\s*\(?|\)$/g, '') || 'อัตโนมัติ') + ')</a>';
    else if (it.inJob) badge = '<span class="tag tag-job">📂 ' + esc(it.inJobLabel) + '</span>';
    else if (it.human) badge = '<span class="tag">ตัดสินแล้ว: ' + esc(it.human) + '</span>';
    else if (/กติกา: ข้าม/.test(it.source)) badge = '<span class="tag tag-skip">ข้าม (คำตอบรับ)</span>';
    else badge = '<span class="tag tag-ai">AI: ' + esc(it.action) + (it.jobLabel ? ' → ' + esc(it.jobLabel) : '') + ' · ' + it.conf + '%</span>';
    const on = state.selected.has(it.row);
    return '<div class="rv chat' + (done && !aiDid ? ' done' : '') + (on ? ' picked' : '') + '"><label class="pick">' +
      (done ? '' : '<input type="checkbox" data-pick="' + it.row + '"' + (on ? ' checked' : '') + '>') +
      '<span class="muted small">' + esc(fmtDateTime(it.time)) + ' · ' + esc(it.sender) + '</span></label>' +
      '<div class="text">' + esc(it.text) + '</div>' + badge + (it.reason && !done ? '<div class="muted small">' + esc(it.reason) + '</div>' : '') +
      (!done && it.inJobs && it.inJobs.length ? '<div>' + partialNote(it.inJobs) + '</div>' : '') + '</div>';
  }

  function bindPicks() {
    $app.querySelectorAll('[data-pick]').forEach(box => box.onchange = () => {
      const row = Number(box.dataset.pick);
      if (box.checked) state.selected.add(row); else state.selected.delete(row);
      box.closest('.rv').classList.toggle('picked', box.checked);
      drawBulkBar();
    });
  }

  function missedSheet() {
    const statuses = (state.review || state.chat || {}).statuses || (state.me && state.me.statuses) || FLOW;
    sheet('<h2>เพิ่มงานที่พลาด</h2><p class="muted small">งานที่ไม่อยู่ในคิวและหาข้อความไม่เจอ (เหมือน “ตรวจ พลาด …” ในแชท) ' +
      'ถ้าเจอข้อความในโหมด “ไล่ตามแชท” ให้ติ๊กข้อความนั้นแทน จะได้ไทม์ไลน์ครบ</p>' +
      '<label class="field">ชื่องาน (ลูกค้า + เครื่อง/อาการ ใส่เบอร์ได้)<input id="f-title" maxlength="120"></label>' +
      '<label class="field">สถานะ<select id="f-status">' + statusOptions(statuses, 'รับแจ้ง') + '</select></label>' +
      '<div class="actions"><button class="btn primary" id="f-ok">เปิดงาน</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      el.querySelector('#f-ok').onclick = async e => {
        const title = el.querySelector('#f-title').value.trim();
        if (!title) { toast('ใส่ชื่องานก่อน'); return; }
        busy(e.target);
        try {
          const out = await api('newJob', { title, status: el.querySelector('#f-status').value });
          closeSheet();
          toast('เปิดงาน ' + out.label + ' ✅');
        } catch (err) {
          if (err.message !== 'login') toast('⚠️ ' + err.message);
          unbusy();
        }
      };
    });
  }

  function drawReview() {
    const data = state.review;
    if (!data.items.length) {
      $app.innerHTML = reviewHeader() + '<div class="center"><p>✅ ไม่มีข้อที่ต้องตรวจ</p><p class="muted small">ข้อเสนอของ AI ตัดสินครบทุกข้อแล้ว · ' +
        'ถ้าคิดว่า AI ข้ามงานไป ดูในโหมด “ไล่ตามแชท”</p></div>';
      bindReviewHeader();
      drawBulkBar();
      return;
    }
    let html = reviewHeader() + '<p class="muted small">ข้อเสนอของ AI ที่ยังไม่มีคนยืนยัน ' + data.items.length +
      ' ข้อ เรียงจากเก่าไปใหม่ · ติ๊กหลายข้อแล้วกดแถบด้านล่างได้</p>';
    REVIEW_GROUPS.forEach(([key, title, test]) => {
      const list = data.items.map((it, i) => [it, i]).filter(([it]) => test(it));
      if (!list.length) return;
      const allOn = list.every(([it]) => state.selected.has(it.row));
      html += '<section class="group"><h3 class="group-head"><label><input type="checkbox" data-all="' + key + '"' +
        (allOn ? ' checked' : '') + '> ' + esc(title) + ' (' + list.length + ')</label></h3>';
      list.forEach(([it, i]) => { html += reviewHtml(it, i); });
      html += '</section>';
    });
    $app.innerHTML = html + '<div class="bulk-spacer"></div>';
    bindReviewHeader();
    $app.querySelectorAll('[data-act]').forEach(btn => btn.onclick = () => {
      const it = data.items[Number(btn.dataset.i)];
      if (btn.dataset.act === 'notjob') { busy(btn); decide(it, { decision: 'notjob' }, 'บันทึกว่าไม่เกี่ยวแล้ว'); }
      else if (btn.dataset.act === 'dupe') { busy(btn); decide(it, { decision: 'attach', job: btn.dataset.job, status: '' }, 'แนบเข้า ' + btn.dataset.job + ' แล้ว'); }
      else if (btn.dataset.act === 'new') newSheet([it], data.statuses);
      else if (btn.dataset.act === 'part') partFromReview([it]);
      else attachSheet([it], data.statuses);
    });
    bindPicks();
    $app.querySelectorAll('[data-all]').forEach(box => box.onchange = () => {
      const test = REVIEW_GROUPS.find(g => g[0] === box.dataset.all)[2];
      data.items.filter(test).forEach(it => { if (box.checked) state.selected.add(it.row); else state.selected.delete(it.row); });
      drawReview();
    });
    drawBulkBar();
  }

  function reviewHtml(it, i) {
    const confCls = it.conf >= 90 ? 'conf-hi' : it.conf >= 70 ? 'conf-mid' : 'conf-lo';
    let ai = '<b>AI: ' + esc(it.action) + '</b>';
    if (it.jobLabel) ai += ' → ' + esc(it.jobLabel);
    if (it.title) ai += '<br>ชื่องาน: ' + esc(it.title);
    if (it.status) ai += '<br>สถานะ: ' + esc(it.status);
    if (it.candidates.length) ai += '<br>อาจเป็น: ' + it.candidates.map(c => esc(c.label)).join(' / ');
    ai += '<br><span class="' + confCls + '">มั่นใจ ' + it.conf + '%</span> · ' + esc(it.reason);
    if (it.inJobs && it.inJobs.length) ai += '<br>' + partialNote(it.inJobs);
    const dup = it.dupes && it.dupes.length;
    const on = state.selected.has(it.row);
    return '<div class="rv' + (on ? ' picked' : '') + '"><label class="pick"><input type="checkbox" data-pick="' + it.row + '"' +
      (on ? ' checked' : '') + '><span class="muted small">' + esc(fmtDateTime(it.time)) + ' · ' + esc(it.sender) + '</span></label>' +
      '<div class="text">' + esc(it.text) + '</div><div class="ai">' + ai + '</div>' + (dup ? dupeBox(it.dupes, i) : '') + '<div class="actions">' +
      '<button class="btn' + (it.action === 'งานใหม่' && !dup ? ' primary' : '') + '" data-act="new" data-i="' + i + '">＋ งานใหม่</button>' +
      '<button class="btn' + (it.action === 'อัปเดตงานเดิม' ? ' primary' : '') + '" data-act="attach" data-i="' + i + '">📎 แนบงานเดิม</button>' +
      '<button class="btn" data-act="notjob" data-i="' + i + '">ไม่เกี่ยว</button>' +
      '<button class="btn" data-act="part" data-i="' + i + '">🔧 ถอดอะไหล่</button></div></div>';
  }

  // งานที่อาจซ้ำ (ลูกค้า/เบอร์/SN เดียวกัน เปิดไว้แล้วจากแชทน้องจ๊อบ ฟอร์ม หรือคิวตรวจ) · ปุ่มแนบเข้างานนั้นได้เลย
  const VIA = { 'แชทน้องจ๊อบ': 'เปิดจากแชทน้องจ๊อบ', 'ฟอร์มเว็บ': 'เปิดจากฟอร์ม', 'คิวตรวจ': 'เปิดจากคิวตรวจ', 'แยกงาน': 'แยกจากงานอื่น', 'กลุ่ม': 'เปิดในกลุ่ม' };
  function dupeBox(dupes, i) {
    return '<div class="dupe"><b>⚠️ อาจเปิดงานนี้ไปแล้ว</b>' + dupes.map(d => '<div class="dupe-row"><div><a href="#job/' + noDigits(d.no) + '">' + esc(d.label) + '</a>' +
      '<div class="muted small">' + esc([VIA[d.via] || d.via, fmtDateTime(d.opened), d.by ? 'โดย ' + d.by : ''].filter(Boolean).join(' · ')) + ' · ' + esc(d.why) + '</div></div>' +
      (i === undefined ? '' : '<button class="btn primary" data-act="dupe" data-i="' + i + '" data-job="' + esc(d.no) + '">📎 แนบเข้า ' + esc(d.no) + '</button>') + '</div>').join('') + '</div>';
  }

  function selectedItems() {
    return state.selected ? currentItems().filter(it => state.selected.has(it.row)) : [];
  }

  // แถบล่างเมื่อมีข้อที่ติ๊ก
  function drawBulkBar() {
    let bar = document.getElementById('bulkbar');
    const items = location.hash === '#review' ? selectedItems() : [];
    if (!items.length) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'bulkbar';
      bar.className = 'bulkbar';
      document.body.appendChild(bar);
    }
    const unsure = items.filter(it => it.action === 'ไม่แน่ใจ' || !['งานใหม่', 'อัปเดตงานเดิม', 'ไม่เกี่ยวกับงาน'].includes(it.action)).length;
    const dups = items.filter(it => it.action === 'งานใหม่' && it.dupes && it.dupes.length).length;
    bar.innerHTML = '<div class="bulk-row"><b>เลือก ' + items.length + ' ข้อ</b><button class="icon-btn" id="bk-clear">ล้าง</button></div>' +
      '<div class="bulk-row actions">' +
      '<button class="btn primary" id="bk-accept">✓ ทำตาม AI' + (unsure || dups ? ' (ข้าม ' + [unsure ? unsure + ' ข้อไม่แน่ใจ' : '', dups ? dups + ' ข้ออาจซ้ำ' : ''].filter(Boolean).join(', ') + ')' : '') + '</button>' +
      '<button class="btn" id="bk-new">＋ รวมเป็นงานใหม่ 1 งาน</button>' +
      '<button class="btn" id="bk-attach">📎 แนบเข้างาน…</button>' +
      '<button class="btn" id="bk-notjob">ไม่เกี่ยว</button>' +
      '<button class="btn" id="bk-part">🔧 เปิดเป็นถอดอะไหล่</button></div>';
    bar.querySelector('#bk-clear').onclick = () => { state.selected.clear(); if (state.reviewMode === 'chat') drawChat(); else drawReview(); };
    bar.querySelector('#bk-accept').onclick = e => { busy(e.target); decideMany({ decision: 'accept' }); };
    bar.querySelector('#bk-notjob').onclick = e => { busy(e.target); decideMany({ decision: 'notjob' }); };
    const statuses = (state.reviewMode === 'chat' ? state.chat : state.review).statuses;
    bar.querySelector('#bk-new').onclick = () => newSheet(items, statuses);
    bar.querySelector('#bk-attach').onclick = () => attachSheet(items, statuses);
    bar.querySelector('#bk-part').onclick = () => partFromReview(items);
  }

  /** คิวตรวจ → ฟอร์มถอดอะไหล่ (เติมเลขงานที่ AI เสนอ + ข้อความแชทเป็นโน้ต) · บันทึกแล้ว ข้อในคิว = แนบเข้างานนั้น / ไม่มีเลขงาน = ไม่เกี่ยวกับงานซ่อม */
  function partFromReview(items) {
    Object.keys(partForm).forEach(k => delete partForm[k]);
    partForm.files = [];
    partForm.fromReview = items.map(it => ({ row: it.row, msgId: it.msgId }));
    partForm.reviewText = items.map(it => fmtDateTime(it.time) + ' ' + it.sender + ': ' + it.text).join('\n').slice(0, 400);
    const job = items.map(it => it.jobLabel || it.inJob || '').find(Boolean);
    if (job) partForm.jobNo = noDigits(job);
    // รูป/คลิปในก้อนข้อความนั้น แนบเข้ารายการด้วย (Worker หาทั้งก้อน + ดึงเข้า Cloudflare ให้)
    partForm.files.push({ url: '', state: 'กำลังดึงรูปจากแชท…', fromChat: true, loading: true });
    location.hash = '#part-new';
    core('chunkMedia', { msgIds: items.map(it => it.msgId) }).then(out => {
      partForm.files = partForm.files.filter(f => !f.loading).concat(out.items.map(m => ({ key: m.key, url: m.url, type: m.type, fromChat: true,
        state: m.url ? '' : 'รอดึงจาก NAS' })));
      if (!out.items.length) toast('ข้อความนี้ไม่มีรูป/คลิป');
    }).catch(err => { partForm.files = partForm.files.filter(f => !f.loading); if (err.message !== 'login') toast('ดึงรูปจากแชทไม่ได้: ' + err.message); })
      .then(() => { if (window.partDrawFiles) window.partDrawFiles(); });
  }

  // ติ๊กหลายข้อ: เหมือน decide — ปิดหน้าต่าง เอาข้อออกจากจอทันที แล้วบันทึกเบื้องหลัง
  function decideMany(choice, list) {
    const picked = list || selectedItems();
    if (!picked.length) return;
    const items = picked.map(it => ({ row: it.row, msgId: it.msgId }));
    queueSave(picked, () => api('decideMany', Object.assign({ items }, choice)),
      out => 'ทำแล้ว ' + out.done + ' ข้อ' + (out.skipped ? ' · ข้าม ' + out.skipped + ' ข้อ' + (out.why && out.why.length ? ' (' + out.why.join(' / ') + ')' : '') : '') +
        (out.job ? ' · ' + out.job : '') + aiNote(out.ai), err => dupeAsk(picked, choice, err));
  }

  // AI อ่านข้อความ/รูปแล้วเติมข้อมูลงานให้ (Worker) → บอกว่าเติมช่องไหน
  const aiNote = list => list && list.length ? ' · 🤖 AI เติม ' + list.join(', ') : '';

  // noClose = ย้ายข้อความในหน้างานตั้งเป็นปิดไม่ได้ (ปิดจากหน้างานต้องมีสรุป) · คิวตรวจปิดได้ ไม่บังคับสรุป
  const statusOptions = (statuses, selected, withKeep, noClose) => (statuses = statuses.filter(s => !noClose || s !== 'ปิด'),
    (withKeep ? '<option value="">ไม่เปลี่ยนสถานะ</option>' : '') +
    statuses.map(s => '<option' + (s === selected ? ' selected' : '') + '>' + esc(s) + '</option>').join(''));
  const reviewNoteField = '<label class="field">โน้ต (ไม่บังคับ) เช่น แก้อะไรไป / ลูกค้ารับเครื่องแล้ว<textarea id="f-note" rows="2" maxlength="1000"></textarea></label>';

  function newSheet(items, statuses) {
    const first = items[0];
    const many = items.length > 1;
    const dupes = [...new Map(items.flatMap(it => it.dupes || []).map(d => [d.no, d])).values()];
    sheet('<h2>' + (many ? 'รวม ' + items.length + ' ข้อเป็นงานใหม่ 1 งาน' : 'เปิดงานใหม่') + '</h2>' + (dupes.length ? dupeBox(dupes, -1) : '') +
      '<label class="field">ชื่องาน<input id="f-title" maxlength="120" value="' + esc(first.title || '') +
      '"></label><label class="field">สถานะ<select id="f-status">' + statusOptions(statuses, first.status || 'รับแจ้ง') +
      '</select></label>' + reviewNoteField + '<p class="muted small">🤖 AI จะอ่านข้อความและรูปทั้งหมดที่เลือก แล้วเติมข้อมูลงาน (ลูกค้า เบอร์ สินค้า SN อาการ ที่อยู่) ให้เอง</p>' +
      '<div class="actions"><button class="btn' + (dupes.length ? '' : ' primary') + '" id="f-ok">' + (dupes.length ? 'เปิดงานใหม่ (คนละงานจริง)' : 'เปิดงาน') +
      '</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      const run = choice => { if (many) decideMany(choice); else decide(first, choice, null); };
      // เห็นคำเตือนแล้วยังกดเปิดใหม่ = ยืนยันว่าเป็นคนละงาน (force)
      el.querySelector('#f-ok').onclick = e => {
        busy(e.target);
        run({ decision: 'new', title: el.querySelector('#f-title').value.trim(), status: el.querySelector('#f-status').value, note: el.querySelector('#f-note').value.trim(), force: dupes.length > 0 });
      };
      el.querySelectorAll('[data-act="dupe"]').forEach(b => b.onclick = () => {
        busy(b);
        run({ decision: 'attach', job: b.dataset.job, status: el.querySelector('#f-status').value, note: el.querySelector('#f-note').value.trim() });
      });
    });
  }

  function attachSheet(items, statuses) {
    const opts = [];
    items.forEach(it => {
      if (it.job && !opts.some(o => o.no === it.job)) opts.push({ no: it.job, label: it.jobLabel });
      it.candidates.forEach(c => { if (!opts.some(o => o.no === c.no)) opts.push(c); });
    });
    const many = items.length > 1;
    sheet('<h2>' + (many ? 'แนบ ' + items.length + ' ข้อเข้างานเดียวกัน' : 'แนบเข้างานเดิม') + '</h2>' +
      // ค้นงานตรงนี้เลย (เหมือนแท็บค้นหา) ไม่ต้องออกไปค้นแล้วกลับมา · เจอรายการถอดอะไหล่ด้วย (P-0003)
      '<div class="field"><span class="lbl">🔍 ค้นงาน / อะไหล่</span><div class="search-row"><input class="search" id="f-q" type="search" enterkeyhint="search" ' +
      'placeholder="ชื่อลูกค้า เบอร์ รุ่น SN P-0003 หรือคำในแชท"><button type="button" class="btn" id="f-go">ค้นหา</button></div><div id="f-res"></div></div>' +
      // คุยเรื่องอะไหล่ที่ถอด (ก่อน/หลังบันทึก) → แนบเข้ารายการ P-xxxx ได้ (ผู้ใช้ 29 ต.ค. 2569)
      '<label class="field">เลขงาน / รายการถอดอะไหล่<select id="f-pick">' + opts.map(o => '<option value="' + esc(o.no) + '">' + esc(o.label) + '</option>').join('') +
        '<option value="">พิมพ์เลขงานเอง…</option></select>' +
      '<input id="f-job" inputmode="numeric" placeholder="เช่น 131"' + (opts.length ? ' hidden' : '') + '></label>' +
      '<label class="field">สถานะ<select id="f-status">' + statusOptions(statuses, many ? '' : items[0].status, true) + '</select></label>' + reviewNoteField +
      '<div class="actions"><button class="btn primary" id="f-ok">แนบ</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      const pick = el.querySelector('#f-pick');
      const input = el.querySelector('#f-job');
      pick.onchange = () => { input.hidden = !!pick.value; };
      // รายการถอดอะไหล่ที่ยังไม่ใส่คืน ต่อท้ายรายการเลือก (โหลดครั้งเดียว เก็บไว้ใน state.parts เหมือนแท็บอะไหล่)
      const addParts = list => {
        if (!list.length || pick.querySelector('optgroup')) return;
        const g = document.createElement('optgroup');
        g.label = '🔧 ถอดอะไหล่ (ยังไม่ใส่คืน)';
        list.forEach(p => g.appendChild(new Option(p.no + ' ' + partName(p) + (p.customer ? ' · ' + p.customer : ''), p.no)));
        const cur = pick.value;   // ใส่กลุ่มใหม่แล้วตัวที่เลือกอยู่ต้องไม่เปลี่ยน
        pick.insertBefore(g, pick.lastChild);
        pick.value = cur;
      };
      if (state.parts) addParts(state.parts.open);
      else core('parts').then(d => { state.parts = d; addParts(d.open); }).catch(() => {});
      const q = el.querySelector('#f-q'), res = el.querySelector('#f-res');
      const choose = (no, label) => { // เลือกจากผลค้น → ใส่เป็นเลขงาน/รายการที่จะแนบ
        let o = [...pick.options].find(x => x.value === no);
        if (!o) { o = new Option(label, no); pick.insertBefore(o, pick.firstChild); }
        pick.value = no; input.hidden = true;
        res.querySelectorAll('.res-job').forEach(b => b.classList.toggle('on', b.dataset.no === no));
      };
      const go = async () => {
        const v = q.value.trim();
        if (v.length < 2) return toast('พิมพ์อย่างน้อย 2 ตัวอักษร');
        res.innerHTML = '<div class="muted small">กำลังค้น…</div>';
        try {
          const out = await core('search', { q: v });
          const jobs = out.jobs.slice(0, 8), parts = (out.parts || []).slice(0, 5);
          res.innerHTML = parts.map(p => '<button type="button" class="res-job" data-no="' + esc(p.no) + '" data-label="' + esc(p.no + ' ' + partName(p)) + '">🔧 <b>' + esc(p.no) + '</b> ' +
            esc(partName(p)) + ' <span class="pill">' + esc(p.status) + '</span><div class="muted small">' + esc(['จาก ' + (partDonor(p) || '-'), p.job && '→ ' + p.job, p.customer].filter(Boolean).join(' · ')) +
            '</div></button>').join('') + (jobs.length || parts.length ? jobs.map(j => {
            const no = j.merged || j.no;
            return '<button type="button" class="res-job" data-no="' + esc(no) + '" data-label="' + esc(no + ' ' + j.title) + '"><b>' + esc(no) + '</b> ' + esc(j.title) +
              ' <span class="pill ' + ph(j.status) + '">' + esc(shortStatus(j.status)) + '</span><div class="muted small">' + esc([j.customer, j.phone, 'เปิด ' + fmtDate(j.opened)].filter(Boolean).join(' · ')) +
              (j.merged ? ' · รวมเข้า ' + esc(j.merged) : '') + '</div></button>';
          }).join('') : '<div class="muted small">ไม่พบงานที่ตรงกับ "' + esc(v) + '"</div>');
          res.querySelectorAll('.res-job').forEach(b => b.onclick = () => choose(b.dataset.no, b.dataset.label));
        } catch (err) { if (err.message !== 'login') res.innerHTML = '<div class="small">⚠️ ' + esc(err.message) + '</div>'; }
      };
      el.querySelector('#f-go').onclick = go;
      q.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
      el.querySelector('#f-ok').onclick = e => {
        const job = pick.value || input.value.trim();
        if (!job) { toast('ใส่เลขงานก่อน'); return; }
        busy(e.target);
        const status = el.querySelector('#f-status').value, note = el.querySelector('#f-note').value.trim();
        const choice = /^p/i.test(job) ? { decision: 'part', part: job, status, note } : { decision: 'attach', job, status, note };
        if (many) decideMany(choice); else decide(items[0], choice, null);
      };
    });
  }

  // ตรวจทีละข้อ: เอาข้อออกจากจอทันที แล้วบันทึกเบื้องหลังเรียงตามลำดับ (Apps Script ช้า ~3–5 วิ/ข้อ ไม่ต้องรอ)
  // บันทึกครบทุกข้อแล้วค่อยโหลดคิวใหม่เงียบ ๆ ครั้งเดียว · ข้อไหนพลาด แจ้งแล้วโหลดคิวใหม่ (ข้อนั้นกลับมา)
  let saveChain = Promise.resolve(), saving = 0;
  const pendingRows = new Set(); // ข้อที่ส่งบันทึกแล้วแต่ยังไม่เสร็จ: โหลดคิวระหว่างนี้ต้องไม่แสดงซ้ำ
  function decide(it, choice, okMsg) {
    queueSave([it], () => api('decide', Object.assign({ row: it.row, msgId: it.msgId }, choice)), out => (okMsg || out.verdict) + aiNote(out.ai),
      err => dupeAsk([it], choice, err));
  }

  /** ระบบตอบว่าอาจซ้ำ (เช่น คิวบนจอเก่า / ไล่ตามแชท) → ถาม: แนบเข้างานนั้น หรือยืนยันเปิดใหม่ */
  function dupeAsk(items, choice, err) {
    if (err.code !== 'maybe_duplicate' || !err.dupes) return false;
    const many = items.length > 1;
    sheet('<h2>⚠️ อาจเปิดงานนี้ไปแล้ว</h2><p class="muted small">ลูกค้านี้มีงานที่เปิดไว้ใกล้ ๆ กัน ดูให้แน่ใจก่อนเปิดใหม่</p>' + dupeBox(err.dupes) +
      '<div class="actions">' + err.dupes.map(d => '<button class="btn primary" data-job="' + esc(d.no) + '">📎 แนบเข้า ' + esc(d.no) + '</button>').join('') +
      '<button class="btn" id="f-force">＋ เปิดงานใหม่ (คนละงานจริง)</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      const go = c => many ? decideMany(c, items) : decide(items[0], c, null);
      el.querySelectorAll('[data-job]').forEach(b => b.onclick = () => go({ decision: 'attach', job: b.dataset.job, status: choice.status || '', note: choice.note || '' }));
      el.querySelector('#f-force').onclick = () => go(Object.assign({}, choice, { force: true }));
    });
    return true;
  }

  /** ปิดหน้าต่าง + เอาข้อออกจากจอทันที → ส่งบันทึกต่อคิว (ทีละคำขอ เรียงตามลำดับที่กด) */
  function queueSave(list, call, okText, onErr) {
    closeSheet();
    unbusy();
    const rows = new Set(list.map(it => it.row));
    rows.forEach(r => { pendingRows.add(r); state.selected && state.selected.delete(r); });
    if (state.review) {
      state.review.items = state.review.items.filter(x => !rows.has(x.row));
      setBadge(state.review.items.length);
    }
    if (location.hash === '#review') { const y = window.scrollY; if (state.reviewMode === 'chat') drawChat(); else drawReview(); window.scrollTo(0, y); }
    saving++;
    drawSaving();
    saveChain = saveChain.then(call)
      .then(out => toast(okText(out) + ' ✅'))
      .catch(err => { if (onErr && onErr(err)) return; if (err.message !== 'login') toast('⚠️ บันทึกไม่สำเร็จ: ' + err.message + ' (ข้อนั้นกลับเข้าคิวแล้ว)'); })
      .then(() => {
        saving--;
        rows.forEach(r => pendingRows.delete(r));
        drawSaving();
        if (!saving && location.hash === '#review' && document.getElementById('sheet').hidden) refreshReviewQuietly();
      });
  }

  function drawSaving() {
    let el = document.getElementById('saving');
    if (!saving) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'saving'; el.className = 'saving'; document.body.appendChild(el); }
    el.textContent = '⏳ กำลังบันทึก ' + saving + ' ข้อ…';
  }
  window.addEventListener('beforeunload', e => { if (saving) { e.preventDefault(); e.returnValue = ''; } });

  // โหลดคิวใหม่โดยไม่ล้างจอ (คงตำแหน่งเลื่อน) — ได้ตัวเลือกงานใหม่ที่เพิ่งเปิด และข้อที่บันทึกพลาดกลับมา
  async function refreshReviewQuietly() {
    try {
      if (state.reviewMode === 'chat') return renderReview();
      const review = await api('review');
      if (saving || location.hash !== '#review' || state.reviewMode !== 'queue' || !document.getElementById('sheet').hidden) return;
      state.review = review;
      setBadge(review.items.length);
      const y = window.scrollY; drawReview(); window.scrollTo(0, y);
    } catch (err) { /* เงียบ: กดแท็บคิวตรวจซ้ำเพื่อโหลดใหม่ได้ */ }
  }

  // ---------- สถิติ ----------
  const WEEKDAYS = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'];
  const RANGES = [['7', '7 วัน'], ['30', '30 วัน'], ['month', 'เดือนนี้'], ['lastmonth', 'เดือนก่อน'], ['90', '90 วัน'], ['custom', 'เลือกเอง']];

  function rangeOf(key) {
    const d = new Date();
    const fmt = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    if (key === 'month') return [fmt(new Date(d.getFullYear(), d.getMonth(), 1)), todayKey()];
    if (key === 'lastmonth') return [fmt(new Date(d.getFullYear(), d.getMonth() - 1, 1)), fmt(new Date(d.getFullYear(), d.getMonth(), 0))];
    if (key === 'custom') return [state.statsFrom || todayKey(-29), state.statsTo || todayKey()];
    return [todayKey(-(Number(key) - 1)), todayKey()];
  }

  async function renderStats() {
    setTab('stats');
    const live = claim();
    state.statsRange = state.statsRange || pref('statsRange') || '30';
    const [from, to] = rangeOf(state.statsRange);
    $app.innerHTML = statsHeader(from, to) + '<div class="center muted">กำลังคำนวณสถิติ…</div>';
    bindStatsHeader();
    const st = await api('stats', { from, to });
    if (live()) drawStats(st);
  }

  function statsHeader(from, to) {
    let html = '<div class="range">' + RANGES.map(([k, l]) => '<button class="chip' + (state.statsRange === k ? ' on' : '') +
      '" data-range="' + k + '">' + l + '</button>').join('') + '</div>';
    if (state.statsRange === 'custom') {
      html += '<div class="range-custom"><input type="date" id="st-from" max="' + todayKey() + '" value="' + esc(from) +
        '"><span>ถึง</span><input type="date" id="st-to" max="' + todayKey() + '" value="' + esc(to) + '"></div>';
    }
    return html;
  }

  function bindStatsHeader() {
    $app.querySelectorAll('[data-range]').forEach(b => b.onclick = () => {
      state.statsRange = b.dataset.range;
      pref('statsRange', state.statsRange);
      renderStats().catch(showError);
    });
    const f = document.getElementById('st-from'), t = document.getElementById('st-to');
    if (f) [f, t].forEach(inp => inp.onchange = () => {
      state.statsFrom = f.value; state.statsTo = t.value;
      if (f.value && t.value && f.value <= t.value) renderStats().catch(showError);
    });
  }

  function drawStats(st) {
    const tot = st.totals;
    const tile = (num, lbl) => '<div class="tile"><div class="num">' + num + '</div><div class="lbl">' + lbl + '</div></div>';
    let html = statsHeader(st.from, st.to) + '<p class="muted small">' + esc(fmtKey(st.from)) + ' – ' + esc(fmtKey(st.to)) + '</p>' +
      '<div class="tiles">' + tile(tot.opened, 'งานเข้า') + tile(tot.closed, 'ปิดงาน') + tile(tot.cancelled, 'ยกเลิก') +
      tile(tot.avgCloseDays === null ? '-' : tot.avgCloseDays, 'วันเฉลี่ยจนปิดงาน') + tile(tot.openNow, 'เปิดอยู่ตอนนี้') + '</div>';

    // รายวัน (ช่วงยาวรวมเป็นรายสัปดาห์ แท่งจะได้ไม่บางเกินไป)
    let daily = st.daily.map(d => ({ label: fmtKey(d.day), values: [d.opened, d.closed] }));
    let dailyTitle = 'งานเข้า / ปิดงาน รายวัน';
    if (daily.length > 45) {
      const weeks = [];
      st.daily.forEach((d, i) => {
        if (i % 7 === 0) weeks.push({ label: fmtKey(d.day), values: [0, 0] });
        const w = weeks[weeks.length - 1];
        w.values[0] += d.opened; w.values[1] += d.closed;
      });
      daily = weeks;
      dailyTitle = 'งานเข้า / ปิดงาน รายสัปดาห์ (เริ่มวันที่)';
    }
    html += chartBox(dailyTitle, daily, ['งานเข้า', 'ปิดงาน']);
    html += chartBox('งานเข้า แยกตามวันในสัปดาห์', st.weekday.map((n, i) => ({ label: WEEKDAYS[i], values: [n] })), ['งานเข้า']);
    html += chartBox('งานเข้า / ปิดงาน รายเดือน', st.monthly.map(m => {
      const p = m.month.split('-').map(Number);
      return { label: MONTHS[p[1] - 1] + ' ' + String((p[0] + 543) % 100).padStart(2, '0'), values: [m.opened, m.closed] };
    }), ['งานเข้า', 'ปิดงาน']);

    // สินค้า: แถบแนวนอนสีเดียว + สัดส่วน (ไม่ใช้กราฟวงกลม)
    const total = st.products.reduce((a, p) => a + p.count, 0);
    if (total) {
      const max = Math.max(...st.products.map(p => p.count));
      html += '<div class="panel-box"><h3>งานเข้า แยกตามสินค้า</h3>';
      st.products.forEach(p => {
        html += '<div class="hrow"><span class="lbl">' + esc(p.name) + '</span><span class="track"><span class="fill" style="width:' +
          (p.count / max * 100) + '%"></span></span><span class="val">' + p.count + ' · ' + Math.round(p.count / total * 100) + '%</span></div>';
      });
      html += '<p class="muted small">หมวดสินค้าเดาจากคำในชื่องาน แก้คำค้นได้ที่ชีต Products · ชื่องานชัดขึ้น = แยกหมวดได้แม่นขึ้น</p></div>';
    }
    // งานที่เปิดอยู่ตามสถานะ (สีช่วงงาน)
    const maxS = Math.max(1, ...Object.values(st.byStatus));
    html += '<div class="panel-box"><h3>งานเปิดอยู่ตอนนี้ แยกตามสถานะ</h3>';
    st.statuses.filter(s => st.byStatus[s]).forEach(s => {
      html += '<div class="hrow ' + ph(s) + '"><span class="lbl">' + esc(s) + '</span><span class="track"><span class="fill" style="width:' +
        (st.byStatus[s] / maxS * 100) + '%"></span></span><span class="val">' + st.byStatus[s] + ' งาน</span></div>';
    });
    html += '</div>';
    $app.innerHTML = html;
    bindStatsHeader();
    bindCharts();
  }

  // กราฟแท่ง SVG: 1–2 ชุดข้อมูล แกนเดียว · แตะ/ชี้แท่งเพื่อดูตัวเลข · มีตารางให้ดูแทนกราฟ
  function chartBox(title, rows, names) {
    const W = 340, H = 170, L = 26, B = 22, T = 8;
    const max = Math.max(1, ...rows.flatMap(r => r.values));
    const step = Math.max(1, Math.ceil(max / 4));
    const top = step * Math.ceil(max / step);
    const plotW = W - L - 4, plotH = H - B - T;
    const slot = plotW / Math.max(1, rows.length);
    const n = names.length, gap = 2;
    const barW = Math.max(2, Math.min(18, (slot - 4 - gap * (n - 1)) / n));
    const y = v => T + plotH - v / top * plotH;
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(title) + '">';
    for (let v = 0; v <= top; v += step) {
      svg += '<line class="' + (v ? 'gridline' : 'baseline') + '" x1="' + L + '" x2="' + (W - 4) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
        '<text class="axis" x="' + (L - 4) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + v + '</text>';
    }
    const every = Math.ceil(rows.length / 8);
    rows.forEach((r, i) => {
      const x0 = L + i * slot + (slot - (barW * n + gap * (n - 1))) / 2;
      const tip = r.label + ': ' + names.map((nm, k) => nm + ' ' + r.values[k]).join(' · ');
      svg += '<rect class="hit" data-tip="' + esc(tip) + '" x="' + (L + i * slot) + '" y="' + T + '" width="' + slot + '" height="' + plotH + '"/>';
      r.values.forEach((v, k) => {
        if (!v) return;
        const x = x0 + k * (barW + gap), yy = y(v), h = T + plotH - yy, rr = Math.min(4, barW / 2, h);
        svg += '<path class="bar s' + (k + 1) + '" d="M' + x + ',' + (T + plotH) + 'V' + (yy + rr) + 'Q' + x + ',' + yy + ' ' + (x + rr) + ',' + yy +
          'H' + (x + barW - rr) + 'Q' + (x + barW) + ',' + yy + ' ' + (x + barW) + ',' + (yy + rr) + 'V' + (T + plotH) + 'Z"/>';
      });
      if (i % every === 0) svg += '<text class="axis" x="' + (L + i * slot + slot / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(r.label) + '</text>';
    });
    svg += '</svg>';
    const legend = n > 1 ? '<div class="legend">' + names.map((nm, k) => '<span><i style="background:var(--s' + (k + 1) + ')"></i>' + esc(nm) + '</span>').join('') + '</div>' : '';
    const table = '<details class="table"><summary>ดูเป็นตาราง</summary><table><tr><th></th>' + names.map(nm => '<th>' + esc(nm) + '</th>').join('') +
      '</tr>' + rows.map(r => '<tr><td>' + esc(r.label) + '</td>' + r.values.map(v => '<td>' + v + '</td>').join('') + '</tr>').join('') + '</table></details>';
    return '<div class="panel-box"><h3>' + esc(title) + '</h3>' + legend + '<div class="chart">' + svg + '</div>' +
      '<div class="tip muted">แตะแท่งเพื่อดูตัวเลข</div>' + table + '</div>';
  }

  function bindCharts() {
    $app.querySelectorAll('.chart').forEach(ch => {
      const tip = ch.parentElement.querySelector('.tip');
      const show = e => {
        const t = e.target.closest('.hit');
        if (!t) return;
        tip.textContent = t.dataset.tip;
        tip.classList.remove('muted');
      };
      ch.addEventListener('click', show);
      ch.addEventListener('mouseover', show);
    });
  }

  // ---------- ระบบใหม่บน Cloudflare (ค้นหา / ฟอร์มเปิดงาน) ----------
  const PROVINCES = ['กรุงเทพมหานคร', 'กระบี่', 'กาญจนบุรี', 'กาฬสินธุ์', 'กำแพงเพชร', 'ขอนแก่น', 'จันทบุรี', 'ฉะเชิงเทรา', 'ชลบุรี', 'ชัยนาท',
    'ชัยภูมิ', 'ชุมพร', 'เชียงราย', 'เชียงใหม่', 'ตรัง', 'ตราด', 'ตาก', 'นครนายก', 'นครปฐม', 'นครพนม', 'นครราชสีมา', 'นครศรีธรรมราช',
    'นครสวรรค์', 'นนทบุรี', 'นราธิวาส', 'น่าน', 'บึงกาฬ', 'บุรีรัมย์', 'ปทุมธานี', 'ประจวบคีรีขันธ์', 'ปราจีนบุรี', 'ปัตตานี',
    'พระนครศรีอยุธยา', 'พะเยา', 'พังงา', 'พัทลุง', 'พิจิตร', 'พิษณุโลก', 'เพชรบุรี', 'เพชรบูรณ์', 'แพร่', 'ภูเก็ต', 'มหาสารคาม',
    'มุกดาหาร', 'แม่ฮ่องสอน', 'ยโสธร', 'ยะลา', 'ร้อยเอ็ด', 'ระนอง', 'ระยอง', 'ราชบุรี', 'ลพบุรี', 'ลำปาง', 'ลำพูน', 'เลย', 'ศรีสะเกษ',
    'สกลนคร', 'สงขลา', 'สตูล', 'สมุทรปราการ', 'สมุทรสงคราม', 'สมุทรสาคร', 'สระแก้ว', 'สระบุรี', 'สิงห์บุรี', 'สุโขทัย', 'สุพรรณบุรี',
    'สุราษฎร์ธานี', 'สุรินทร์', 'หนองคาย', 'หนองบัวลำภู', 'อ่างทอง', 'อำนาจเจริญ', 'อุดรธานี', 'อุตรดิตถ์', 'อุทัยธานี', 'อุบลราชธานี'];
  const PRODUCT_HINTS = ['รถขุด TREX T1', 'รถขุด T1.2', 'รถขุด T1.3', 'รถขุด T1.4L', 'รถขุด T1.5K', 'รถขุด T1.6 แทรคเหล็ก', 'รถบด RL600',
    'รถบดนั่งขับ 1.2 ตัน', 'เครื่องตบดิน', 'รถดั๊มพ์ตีนตะขาบ', 'เครื่องตัดคอนกรีต T800B', 'เครื่องตัดคอนกรีต Turbo Max T-600D',
    'เครื่องดัดเหล็ก นิวตัน 25', 'เครื่องดัดเหล็ก นิวตัน 32', 'เครื่องดัดเหล็ก B16', 'เครื่องตัดเหล็ก C32', 'เครื่องเจาะคอริ่ง (ดำ 3800W)',
    'เครื่องเจาะคอริ่ง (น้ำเงิน 3500W)', 'หุ่นยนต์ตัดลวด (wire saw)', 'เครื่องต๊าป 4 นิ้ว', 'เครื่องย้ำโซ่', 'เครื่องปั่นไฟ TREX'];
  const CORE_ERRORS = {
    bad_phone: 'เบอร์โทรต้องมีอย่างน้อย 9 หลัก', no_symptom: 'ใส่อาการก่อน', no_contact: 'ใส่ชื่อลูกค้า หรือเบอร์ อย่างใดอย่างหนึ่ง', no_photo: 'ใส่รูปหรือคลิปอย่างน้อย 1 ไฟล์', storage_off: 'ที่เก็บรูปยังไม่เปิด แจ้งผู้ดูแล',
    bad_type: 'รองรับเฉพาะรูปและคลิป', too_big: 'ไฟล์ใหญ่เกิน 60 MB (ตัดคลิปให้สั้นลง)', bad_image: 'อ่านรูปไม่ได้', ai_failed: 'AI อ่านไม่สำเร็จ ลองใหม่', ai_budget: 'วันนี้ใช้ AI ครบวงเงินแล้ว ลองใหม่พรุ่งนี้',
    need_note: 'เล่าการซ่อม หรือใส่รูปก่อน', need_fix: 'ใส่ชิ้นส่วนที่เสีย หรือวิธีแก้ อย่างน้อย 1 ช่อง',
    core_failed: 'บันทึกงานในระบบเดิมไม่สำเร็จ ลองใหม่', no_title: 'ข้อมูลไม่พอสำหรับตั้งชื่องาน',
    maybe_duplicate: 'อาจซ้ำกับงานที่มีอยู่แล้ว', no_name: 'ใส่ชื่อสินค้าก่อน', too_many_images: 'สินค้านี้มีรูปตัวอย่างครบ 40 รูปแล้ว ลบรูปเก่าก่อน', already_decided: 'ข้อเสนอนี้มีคนตัดสินไปแล้ว',
    no_serial: 'ใส่ SN / เลขเครื่อง (ถ่ายรูปป้ายให้ AI อ่าน หรือเลือก "ป้ายชำรุด" / "ไม่มีป้าย")',
    no_part: 'ใส่ชื่ออะไหล่ที่ถอด', no_donor_serial: 'ใส่ SN ของเครื่องที่ถอด (ถ่ายรูปป้ายให้ AI อ่านได้)', no_target: 'ใส่เลขงานซ่อม หรือชื่อลูกค้าที่ได้อะไหล่',
    media_gone: 'ไฟล์นี้เก่าเกินที่ LINE เก็บไว้ ดูได้จาก NAS', media_wait: 'LINE ยังเตรียมคลิปไม่เสร็จ ลองใหม่ในอีกสักครู่',
    media_retry: 'โหลดไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง', nas_missing: 'ไม่พบไฟล์นี้บน NAS',
    job_not_found: 'ไม่พบเลขงานนี้', part_not_found: 'ไม่พบรายการถอดอะไหล่นี้', part_state: 'รายการนี้เปลี่ยนสถานะไปแล้ว โหลดหน้าใหม่', no_note: 'ใส่เหตุผล / โน้ตก่อน', not_found: 'ไม่พบรายการ'
  };
  const intake = { files: [], attachTo: '' };   // ฟอร์มที่กรอกค้างไว้ (สลับแท็บแล้วกลับมาได้)

  async function core(action, data, timeoutMs) {
    if (!CFG.CORE_URL) throw new Error('ยังไม่ได้ตั้ง CORE_URL ใน config.js');
    const ctrl = new AbortController();
    const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : 0;
    let out;
    try {
      const res = await fetch(CFG.CORE_URL + '/api', { method: 'POST', signal: ctrl.signal,
        body: JSON.stringify(Object.assign({ action, idToken: liff.getIDToken() }, data || {})) });
      out = await res.json().catch(() => ({ error: 'server_error' }));
    } catch (err) {
      const e = new Error('เชื่อมต่อไม่สำเร็จ (เน็ตหลุดหรือระบบตอบช้า) ลองใหม่อีกครั้ง');
      e.network = true;
      throw e;
    } finally { clearTimeout(timer); }
    if (out.ms) console.log('core', action, out.ms + ' ms');
    if (out.error === 'login_expired' || out.error === 'login_required') { liff.login({ redirectUri: location.href }); throw new Error('login'); }
    if (out.error === 'need_details') { const e = new Error('ปิดงานไม่ได้ ยังขาด: ' + (out.missing || []).join(', ') + ' — กด ✏️ แก้ข้อมูลงาน เติมก่อน'); e.code = out.error; e.missing = out.missing; throw e; }
    if (out.error) { const e = new Error(CORE_ERRORS[out.error] || ERRORS[out.error] || out.error); e.code = out.error; e.dupes = out.dupes; throw e; }
    if (action === 'me' && out.primary && out.primary !== state.primary) setPrimary(out.primary);
    return out;
  }

  /** รูปย่อด้านยาว ≤1600 px เป็น JPEG ก่อนส่ง (รูปจากมือถือ 3–8 MB เหลือ ~300 KB) · คลิปส่งตามเดิม */
  function shrink(file, max = 1600) {
    if (!file.type.startsWith('image/')) return Promise.resolve(file);
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        c.toBlob(b => resolve(b || file), 'image/jpeg', 0.85);
      };
      img.onerror = () => resolve(file);
      img.src = URL.createObjectURL(file);
    });
  }
  const toDataUrl = blob => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });

  async function uploadFile(file, max) {
    const blob = await shrink(file, max);
    const res = await fetch(CFG.CORE_URL + '/api/upload', { method: 'POST', body: blob,
      headers: { 'X-Id-Token': liff.getIDToken(), 'Content-Type': blob.type || file.type } });
    const out = await res.json().catch(() => ({ error: 'server_error' }));
    if (out.error) throw new Error(CORE_ERRORS[out.error] || out.error);
    return out.key;
  }

  // ----- ค้นหา -----
  async function renderSearch() {
    setTab('search');
    claim(); // หน้าค้นหาวาดทันที แต่ต้องยกเลิกหน้าที่ยังโหลดค้างอยู่
    const q = state.searchQ || '';
    $app.innerHTML = '<div class="toolbar"><div class="search-row"><input class="search" id="sq" type="search" enterkeyhint="search" ' +
      'placeholder="ชื่อ เบอร์ รุ่น SN จังหวัด P-0003 หรือคำในแชท" value="' + esc(q) + '"><button class="btn primary" id="sgo">ค้นหา</button></div>' +
      '<label class="btn" id="simg-l">📷 ค้นด้วยรูป (ป้ายเครื่อง/SN/นามบัตร)<input type="file" id="simg" accept="image/*" hidden></label></div><div id="sres">' +
      (state.searchHtml || '<div class="center muted">ค้นประวัติจากทุกงาน รายการถอดอะไหล่ และแชทเก่า</div>') + '</div>';
    const input = document.getElementById('sq');
    const go = async () => {
      const v = input.value.trim();
      if (v.length < 2) return toast('พิมพ์อย่างน้อย 2 ตัวอักษร');
      state.searchQ = v;
      document.getElementById('sres').innerHTML = '<div class="center muted">กำลังค้น…</div>';
      try { drawResults(await core('search', { q: v }), v); } catch (err) { if (err.message !== 'login') document.getElementById('sres').innerHTML = '<div class="center">⚠️ ' + esc(err.message) + '</div>'; }
    };
    document.getElementById('sgo').onclick = go;
    input.onkeydown = e => { if (e.key === 'Enter') go(); };
    document.getElementById('simg').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      document.getElementById('sres').innerHTML = '<div class="center muted">AI กำลังอ่านรูป…</div>';
      try {
        const blob = await shrink(f, 1400);
        const out = await core('searchImage', { image: await toDataUrl(blob), mime: 'image/jpeg' });
        const v = out.vision || {};
        const head = '<div class="panel-box"><b>AI อ่านได้:</b> ' + esc([v.product, v.model, v.serial && 'SN ' + v.serial, (v.names || []).join(', '), (v.phones || []).join(', ')]
          .filter(Boolean).join(' · ') || v.summary || '-') + (out.terms.length ? '<div class="muted small">ค้นด้วย: ' + esc(out.terms.join(' · ')) + '</div>' : '') + '</div>';
        drawResults(out, out.terms[0] || '', head);
      } catch (err) { if (err.message !== 'login') document.getElementById('sres').innerHTML = '<div class="center">⚠️ ' + esc(err.message) + '</div>'; }
      e.target.value = '';
    };
  }

  function hitHtml(h) {
    const icon = { msg: '💬', img: '🖼', form: '📝' }[h.kind] || '';
    return '<div class="hit-line">' + icon + ' ' + (h.time ? '<span class="muted">' + esc(fmtDate(h.time)) + (h.who ? ' ' + esc(h.who) : '') + ':</span> ' : '') + esc(h.text) + '</div>';
  }

  function drawResults(out, q, head) {
    let html = head || '';
    const parts = out.parts || [];
    if (!out.jobs.length && !out.loose.length && !parts.length) html += '<div class="center muted">ไม่พบ "' + esc(q) + '"</div>';
    // รายการถอดอะไหล่ (P-0003 / ชื่ออะไหล่ / SN เครื่องที่ถอด) ขึ้นก่อนงานซ่อม — ค้นช่องเดียวเจอทั้งคู่ ไม่ต้องเลือกก่อน
    if (parts.length) html += '<div class="muted small">รายการถอดอะไหล่ ' + parts.length + ' รายการ</div>' + parts.map(p => '<a class="card part-card ' + PART_LEVEL[p.level][2] +
      '" href="#part/' + p.id + '"><div class="top"><span class="no">🔧 ' + esc(p.no) + '</span><span class="title">' + esc(partName(p)) + '</span><span class="age">' + esc(p.status) +
      '</span></div><div class="meta"><span>จาก ' + esc(partDonor(p) || '-') + '</span>' + (p.job ? '<span>→ ' + esc(p.job) + '</span>' : '') + (p.customer ? '<span>' + esc(p.customer) + '</span>' : '') +
      '<span>ถอด ' + esc(fmtMs(p.time)) + ' · ' + esc(p.by) + '</span></div></a>').join('');
    if (out.jobs.length) html += '<div class="muted small"' + (parts.length ? ' style="margin-top:12px"' : '') + '>งานที่เกี่ยวข้อง ' + out.jobs.length + ' งาน</div>';
    out.jobs.forEach(j => {
      const target = j.merged || j.no;
      html += '<a class="card ' + ph(j.status) + '" href="#job/' + noDigits(target) + '"><div class="top"><span class="no">' + esc(j.no) + '</span><span class="title">' +
        esc(j.title) + '</span></div><div class="meta"><span class="pill ' + ph(j.status) + '">' + esc(shortStatus(j.status)) + '</span>' +
        (j.customer ? esc(j.customer) : '') + (j.phone ? ' ' + esc(j.phone) : '') + ' เปิด ' + esc(fmtDate(j.opened)) +
        (j.merged ? ' · รวมเข้า ' + esc(j.merged) : '') + '</div>' + j.hits.map(hitHtml).join('') + '</a>';
    });
    if (out.loose.length) html += '<div class="muted small" style="margin-top:12px">ในแชทที่ยังไม่อยู่ในงาน</div><div class="panel-box">' + out.loose.map(hitHtml).join('') + '</div>';
    state.searchHtml = html;
    const box = document.getElementById('sres'); // ผู้ใช้อาจกดไปแท็บอื่นระหว่างรอผลค้น
    if (box) box.innerHTML = html;
  }

  // ----- ฟอร์มเปิดงาน -----
  function renderNew() {
    setTab('board');
    const v = intake;
    const opt = (list, cur) => '<option value=""></option>' + list.map(p => '<option' + (p === cur ? ' selected' : '') + '>' + esc(p) + '</option>').join('');
    // ฟอร์มเป็นข้อ 1–5 มีเส้นไทม์ไลน์ด้านซ้าย (ผู้ใช้ 30 ต.ค. 2569 · กดเมนู "แจ้งงานซ่อม" เปิดหน้านี้) · ข้อที่กำลังกรอก = กรอบส้ม · ครบ = เขียว ✓
    // ชื่อช่อง (name) เดิมทั้งหมด → keep/submitJob ใช้ได้เหมือนเดิม
    const step = (k, title, req, inner) => '<section class="nstep" data-step="' + k + '"><div class="nstep-dot">' + k + '</div><div class="nstep-body">' +
      '<div class="nstep-head"><b>' + title + '</b>' + (req ? ' <b class="req">*</b>' : ' <span class="muted small">(เติมทีหลังได้)</span>') +
      '<span class="nstep-state"></span></div>' + inner + '</div></section>';
    const mic = name => SPEECH ? '<button type="button" class="btn mic" data-mic="' + name + '">🎤 พูด</button>' : '';
    $app.innerHTML = '<form id="nf" class="intake steps" autocomplete="off">' +
      '<div class="nsteps-top"><b>แจ้งงานซ่อม</b> <span id="nprog" class="muted small"></span></div>' +
      step(1, '📷 รูปเครื่อง / คลิป', true, '<p class="muted small">ถ่ายรูปตัวสินค้าให้เห็นทั้งเครื่อง: ด้านหน้า · ด้านหลัง · ด้านข้าง (+ จุดที่เสีย ถ้ามี)</p><div class="files" id="files"></div>' +
        '<label class="btn step-btn"><input type="file" id="fpick" accept="image/*,video/*" multiple hidden>📷 ถ่าย / เลือกรูป คลิป</label>') +
      step(2, '🏷️ ป้ายเครื่อง / SN', true, '<p class="muted small">ถ่ายป้ายเนมเพลทให้เห็นทั้งสเปคและเลข SN ชัดที่สุด: ถ่ายตรงๆ ไม่เบลอ ไม่สะท้อนแสง</p>' +
        '<label class="btn step-btn"><input type="file" id="plate" accept="image/*" capture="environment" hidden>📷 ถ่ายป้ายเครื่อง ให้ AI อ่าน SN</label>' +
        '<div class="muted small" id="plate-out"></div>' +
        '<input name="serial" value="' + esc(v.serial || '') + '">' +
        '<select name="plateState">' + [['', 'ป้ายอ่านได้ครบ'], ['damaged', 'ป้ายชำรุด / เลขเลือน ขาดบางตัว'], ['none', 'เครื่องไม่มีป้าย / ป้ายหาย']]
          .map(o => '<option value="' + o[0] + '"' + (o[0] === (v.plateState || '') ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>' +
        '<label class="field"><span class="lbl">สินค้า / รุ่น</span><input name="product" list="plist" value="' + esc(v.product || '') + '"><datalist id="plist">' +
          PRODUCT_HINTS.map(p => '<option value="' + esc(p) + '">').join('') + '</datalist></label>') +
      step(3, '👤 ลูกค้า', true, '<p class="muted small">ใส่ชื่อ หรือเบอร์ อย่างน้อยหนึ่งอย่าง</p>' +
        '<label class="field"><span class="lbl">ชื่อลูกค้า / ร้าน</span><div class="search-row"><input name="customer" value="' + esc(v.customer || '') + '">' + mic('customer') + '</div></label>' +
        '<label class="field"><span class="lbl">เบอร์ลูกค้า</span><input name="phone" type="tel" inputmode="tel" value="' + esc(v.phone || '') + '"></label><div id="dup"></div>') +
      step(4, '🛠️ อาการ / สิ่งที่ลูกค้าแจ้ง', false, '<div class="search-row"><textarea name="symptom" rows="3">' + esc(v.symptom || '') + '</textarea>' + mic('symptom') + '</div>' +
        (SPEECH ? '' : '<p class="muted small">🎤 ขี้เกียจพิมพ์: กดไมค์บนคีย์บอร์ดมือถือ แล้วพูดแทนได้</p>')) +
      step(5, '📍 ที่อยู่ / หมุด', false,
        '<label class="check"><input type="checkbox" name="atShop"' + (v.atShop ? ' checked' : '') + '> เครื่องอยู่ที่ศูนย์แล้ว</label>' +
        '<div class="search-row"><button type="button" class="btn" id="geo">📍 ตำแหน่งปัจจุบัน</button>' +
        '<input name="mapUrl" placeholder="หรือวางลิงก์ Google Maps" value="' + esc(v.mapUrl || '') + '"></div><div class="muted small" id="geo-out">' +
        (v.lat ? 'ปักหมุดแล้ว ' + v.lat.toFixed(5) + ', ' + v.lng.toFixed(5) : '') + '</div>' +
        '<label class="field"><span class="lbl">ที่อยู่</span><textarea name="address" rows="2">' + esc(v.address || '') + '</textarea></label>' +
        '<label class="field"><span class="lbl">จังหวัด</span><select name="province">' + opt(PROVINCES, v.province) + '</select></label>') +
      '<label class="check"><input type="checkbox" name="sendCard"' + (v.sendCard === false ? '' : ' checked') + '> ส่งการ์ดงานเข้ากลุ่มช่าง</label>' +
      '<div id="attach-note"></div><button class="btn primary wide" id="nsubmit">เปิดงาน</button></form>';
    const form = document.getElementById('nf');
    const keep = () => { const fd = new FormData(form); ['symptom', 'phone', 'customer', 'product', 'serial', 'address', 'province', 'mapUrl'].forEach(k => { intake[k] = fd.get(k); });
      intake.atShop = form.atShop.checked; intake.sendCard = form.sendCard.checked; intake.plateState = form.plateState.value; };
    form.oninput = () => { keep(); drawSteps(); };
    form.onchange = () => { keep(); drawSteps(); };
    form.plateState.onchange = () => { keep(); drawPlateState(); drawSteps(); };
    form.querySelectorAll('[data-mic]').forEach(b => b.onclick = () => listen(b, form[b.dataset.mic]));
    drawPlateState();
    document.getElementById('plate').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) readPlate(f); };
    drawFiles();
    drawAttach();
    document.getElementById('fpick').onchange = e => { [...e.target.files].forEach(addFile); e.target.value = ''; };
    document.getElementById('geo').onclick = () => {
      const out = document.getElementById('geo-out');
      if (!navigator.geolocation) return toast('เครื่องนี้หาตำแหน่งไม่ได้');
      out.textContent = 'กำลังหาตำแหน่ง…';
      navigator.geolocation.getCurrentPosition(p => {
        intake.lat = p.coords.latitude; intake.lng = p.coords.longitude;
        out.textContent = 'ปักหมุดแล้ว ' + intake.lat.toFixed(5) + ', ' + intake.lng.toFixed(5) + ' (±' + Math.round(p.coords.accuracy) + ' ม.)';
        drawSteps();
      }, () => { out.textContent = 'หาตำแหน่งไม่ได้ (ต้องอนุญาตตำแหน่งให้ LINE)'; }, { enableHighAccuracy: true, timeout: 15000 });
    };
    form.phone.onblur = checkPhone;
    form.onsubmit = submitJob;
    drawSteps();
  }

  // ข้อไหนครบ → จุดเขียว ✓ · ข้อแรกที่ยังไม่ครบ = กรอบส้ม (กำลังกรอก) · ข้อ 1–3 บังคับ
  const STEP_OK = {
    1: f => intake.files.some(x => x.key),
    2: f => { const sn = serialOf(f); return !!sn && !(sn.includes('?') && !sn.startsWith('ป้ายชำรุด')); },
    3: f => !!String(f.customer.value).trim() || String(f.phone.value).replace(/\D/g, '').length >= 9,
    4: f => !!String(f.symptom.value).trim(),
    5: f => f.atShop.checked || !!intake.lat || !!String(f.mapUrl.value).trim() || !!String(f.address.value).trim() || !!f.province.value
  };
  function drawSteps(scroll) {
    const form = document.getElementById('nf');
    if (!form || !form.classList.contains('steps')) return;
    let active = 0, need = 0;
    form.querySelectorAll('.nstep').forEach(sec => {
      const k = Number(sec.dataset.step), ok = STEP_OK[k](form);
      if (!ok && !active) active = k;
      if (k <= 3 && ok) need++;
      sec.classList.toggle('ok', ok);
      sec.classList.toggle('on', !ok && active === k);
      sec.querySelector('.nstep-dot').textContent = ok ? '✓' : k;
      sec.querySelector('.nstep-state').textContent = ok ? '✓ ได้แล้ว' : active === k ? '👉 กรอกข้อนี้' : '';
    });
    document.getElementById('nprog').textContent = need === 3 ? '✅ ข้อบังคับครบแล้ว กดเปิดงานได้' : 'ข้อบังคับ ' + need + '/3';
    document.getElementById('nsubmit').classList.toggle('ready', need === 3);
    // ถ่ายรูป/อ่านป้ายเสร็จ → เลื่อนไปข้อถัดไปให้ (ตอนพิมพ์ไม่เลื่อน กันจอกระโดด)
    if (scroll && active) form.querySelector('.nstep[data-step="' + active + '"]').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // พูดแทนพิมพ์ (มีเฉพาะเครื่อง/เบราว์เซอร์ที่รองรับ · ไม่รองรับ = ใช้ไมค์บนคีย์บอร์ด)
  const SPEECH = window.SpeechRecognition || window.webkitSpeechRecognition;
  function listen(btn, input) {
    const r = new SPEECH();
    r.lang = 'th-TH'; r.interimResults = false;
    btn.textContent = '🔴 กำลังฟัง…';
    r.onresult = e => { const t = e.results[0][0].transcript; input.value = (input.value ? input.value + ' ' : '') + t; input.dispatchEvent(new Event('input', { bubbles: true })); };
    r.onerror = () => toast('ฟังไม่ได้ ลองกดไมค์บนคีย์บอร์ดแทน');
    r.onend = () => { btn.textContent = '🎤 พูด'; };
    try { r.start(); } catch { btn.textContent = '🎤 พูด'; }
  }

  // ป้ายชำรุด = ใส่เลขส่วนที่อ่านได้ (ถ้ามี) แล้วเปิดงานได้ · ไม่มีป้าย = ไม่ต้องใส่เลข
  function drawPlateState() {
    const form = document.getElementById('nf');
    const st = form.plateState.value;
    form.serial.disabled = st === 'none';
    if (st === 'none') form.serial.value = '';
    form.serial.placeholder = st === 'none' ? 'ไม่มี SN' : st === 'damaged' ? 'ใส่ส่วนที่อ่านได้ (ไม่บังคับ) ตัวที่หายใส่ ?' : 'พิมพ์เลข หรือถ่ายรูปป้ายให้ AI อ่าน';
  }
  /** SN ที่ส่งเปิดงาน (Worker ตรวจซ้ำด้วย serialOk) */
  function serialOf(form) {
    const sn = String(form.serial.value).trim();
    const st = form.plateState.value;
    return st === 'none' ? 'ไม่มี SN' : st === 'damaged' ? ('ป้ายชำรุด ' + sn.replace(/^ป้ายชำรุด\s*/, '')).trim() : sn;
  }

  /** รูปป้ายเครื่อง → เก็บเป็นรูปของงานด้วย + AI อ่าน SN/รุ่นมาเติม (ช่างแก้ได้ก่อนกดเปิดงาน) */
  async function readPlate(file) {
    addFile(file);
    const out = document.getElementById('plate-out');
    out.textContent = 'AI กำลังอ่านป้าย…';
    try {
      const r = await core('readPlate', { image: await toDataUrl(await shrink(file, 1600)), mime: 'image/jpeg' });
      const form = document.getElementById('nf');
      if (!form) return;
      if (!r.serial && !r.damaged) { out.textContent = '⚠️ AI ไม่เห็นป้ายเครื่องในรูปนี้ ถ่ายป้ายให้ชัดขึ้น หรือพิมพ์เอง'; return; }
      form.plateState.value = r.damaged ? 'damaged' : ''; intake.plateState = form.plateState.value; drawPlateState();
      form.serial.value = r.serial; intake.serial = r.serial;
      setTimeout(() => drawSteps(true), 0);
      const model = r.product && r.model && !r.product.includes(r.model) ? r.product + ' ' + r.model : r.product || r.model;
      if (!form.product.value && model) { form.product.value = model; intake.product = model; }
      out.textContent = r.damaged ? '🏷️ AI: ป้ายชำรุด / เลขเลือน' + (r.serial ? ' อ่านได้บางส่วน ' + r.serial : ' อ่านเลขไม่ได้') + ' — เปิดงานได้ (ถ้าอ่านเองได้ แก้เลขแล้วเลือก "ป้ายอ่านได้ครบ")'
        : '✅ AI อ่านได้ ' + r.serial + (r.model ? ' · รุ่น ' + r.model : '') + ' — ตรวจว่าตรงป้าย';
    } catch (err) { if (err.message !== 'login') out.textContent = '⚠️ ' + err.message; }
  }

  function addFile(file) {
    const item = { name: file.name, type: file.type.startsWith('video') ? 'video' : 'image', url: URL.createObjectURL(file), state: 'กำลังส่ง' };
    intake.files.push(item);
    drawFiles();
    uploadFile(file).then(key => { item.key = key; item.state = ''; }).catch(err => { item.state = 'ส่งไม่สำเร็จ'; item.error = err.message; toast(err.message); })
      .then(() => { drawFiles(); drawSteps(true); });
  }

  function drawFiles() {
    const el = document.getElementById('files');
    if (!el) return;
    el.innerHTML = intake.files.map((f, i) => '<div class="file">' + (f.type === 'image' ? '<img src="' + f.url + '" alt="">' : '<div class="vid">🎬</div>') +
      (f.state ? '<span class="fstate' + (f.error ? ' bad' : '') + '">' + esc(f.state) + '</span>' : '') +
      '<button type="button" class="fdel" data-i="' + i + '" aria-label="ลบ">✕</button></div>').join('');
    el.querySelectorAll('.fdel').forEach(b => b.onclick = () => { intake.files.splice(Number(b.dataset.i), 1); drawFiles(); drawSteps(); });
  }

  async function checkPhone() {
    const form = document.getElementById('nf');
    const d = String(form.phone.value).replace(/\D/g, '');
    const box = document.getElementById('dup');
    if (d.length < 9) { box.innerHTML = ''; return; }
    try {
      const out = await core('lookupPhone', { phone: d });
      const c = out.customer;
      if (c) { // เติมข้อมูลลูกค้าเดิมเฉพาะช่องที่ยังว่าง
        [['customer', c.customer], ['address', c.address], ['province', c.province], ['mapUrl', c.map_url]].forEach(([k, val]) => {
          if (val && !form[k].value) { form[k].value = val; intake[k] = val; } });
        if (c.lat && !intake.lat) { intake.lat = c.lat; intake.lng = c.lng; }
      }
      const open = out.jobs.filter(j => !/^(ปิด|ยกเลิก|รวมกับงานอื่น)$/.test(j.status));
      if (!out.jobs.length) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="panel-box"><b>เบอร์นี้มีงานแล้ว ' + out.jobs.length + ' งาน</b>' + (open.length ? ' (ยังไม่ปิด ' + open.length + ')' : '') +
        out.jobs.slice(0, 5).map(j => '<div class="dup-row"><a href="#job/' + noDigits(j.merged || j.no) + '">' + esc(j.no) + ' ' + esc(j.title) + '</a> <span class="pill ' + ph(j.status) + '">' +
          esc(shortStatus(j.status)) + '</span>' + (/^(ปิด|ยกเลิก|รวมกับงานอื่น)$/.test(j.status) ? '' : ' <button type="button" class="link-btn" data-attach="' + esc(j.merged || j.no) + '">เพิ่มเข้างานนี้</button>') + '</div>').join('') +
        '<div class="muted small">ถ้าเป็นเครื่อง/อาการใหม่ เปิดงานใหม่ได้ตามปกติ</div></div>';
      box.querySelectorAll('[data-attach]').forEach(b => b.onclick = () => { intake.attachTo = b.dataset.attach; drawAttach(); });
    } catch (err) { /* ไม่ขวางการกรอก */ }
  }

  function drawAttach() {
    const el = document.getElementById('attach-note');
    const btn = document.getElementById('nsubmit');
    if (!el) return;
    el.innerHTML = intake.attachTo ? '<div class="panel-box">จะเพิ่มข้อมูลนี้เข้างาน <b>' + esc(intake.attachTo) + '</b> (ไม่เปิดงานใหม่) <button type="button" class="link-btn" id="unattach">ยกเลิก</button></div>' : '';
    btn.textContent = intake.attachTo ? 'เพิ่มเข้างาน ' + intake.attachTo : 'เปิดงาน';
    const u = document.getElementById('unattach');
    if (u) u.onclick = () => { intake.attachTo = ''; drawAttach(); };
  }

  async function submitJob(e) {
    e.preventDefault();
    const form = e.target;
    if (!intake.files.length) return toast('ใส่รูปหรือคลิปอย่างน้อย 1 ไฟล์');
    if (intake.files.some(f => f.state === 'กำลังส่ง')) return toast('รอส่งรูป/คลิปให้เสร็จก่อน');
    const phoneDigits = String(form.phone.value).replace(/\D/g, '');
    if (!intake.attachTo && !phoneDigits && !String(form.customer.value).trim()) { form.customer.focus(); return toast(CORE_ERRORS.no_contact); }
    if (phoneDigits && phoneDigits.length < 9) return toast(CORE_ERRORS.bad_phone);
    const serial = serialOf(form);
    if (!intake.attachTo && (!serial || (serial.includes('?') && !serial.startsWith('ป้ายชำรุด')))) {
      form.serial.focus(); return toast(serial ? 'SN มีตัวที่อ่านไม่ชัด (?) แก้ให้ถูก หรือเลือก "ป้ายชำรุด"' : CORE_ERRORS.no_serial); }
    const btn = document.getElementById('nsubmit');
    busy(btn);
    try {
      const fd = new FormData(form);
      const job = { symptom: fd.get('symptom'), phone: fd.get('phone'), customer: fd.get('customer'), product: fd.get('product'), serial,
        address: fd.get('address'), province: fd.get('province'), mapUrl: fd.get('mapUrl'), lat: intake.lat, lng: intake.lng,
        atShop: form.atShop.checked, sendCard: form.sendCard.checked, attachTo: intake.attachTo, files: intake.files.filter(f => f.key).map(f => f.key) };
      const out = await core('createJob', { job });
      const later = [!job.symptom.trim() && 'อาการ', !job.customer.trim() && 'ชื่อลูกค้า', String(job.phone).replace(/\D/g, '').length < 9 && 'เบอร์'].filter(Boolean);
      const done = { no: out.no, url: out.url, card: out.card, print: out.print, dm: out.dm, attached: !!intake.attachTo, later,
        label: { no: out.no, model: job.product, symptom: job.symptom, customer: job.customer } };
      intake.files.forEach(f => URL.revokeObjectURL(f.url));
      Object.keys(intake).forEach(k => delete intake[k]);
      intake.files = []; intake.attachTo = '';
      state.board = null; // บอร์ดโหลดใหม่ให้เห็นงานนี้
      drawCreated(done);
    } catch (err) {
      if (err.message !== 'login') toast(err.message);
    } finally { unbusy(); }
  }

  /** ป้าย 50×30 มม. (567×354 จุด ที่ 300 dpi) วาดในเครื่อง — พิมพ์จากแอป NIIMBOT ได้ */
  function labelCanvas(l, url) {
    const c = document.createElement('canvas');
    c.width = 567; c.height = 354;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    const n = qr.getModuleCount(), cell = Math.floor(250 / n), off = 8 + Math.floor((250 - cell * n) / 2);
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) g.fillRect(off + k * cell, 14 + r * cell, cell, cell);
    const x = 270, fit = (t, w) => { t = String(t || ''); while (t && g.measureText(t).width > w) t = t.slice(0, -2) + '…'; return t; };
    const now = new Date();
    g.font = '700 60px "Noto Sans Thai", sans-serif'; g.fillText(l.no, x, 62);
    g.font = '23px "Noto Sans Thai", sans-serif'; g.fillText(fmtDate(now.toISOString()) + ' ' + now.getFullYear() + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'), x, 100);
    g.font = '700 27px "Noto Sans Thai", sans-serif'; g.fillText(fit(l.model, 290), x, 148);
    g.font = '24px "Noto Sans Thai", sans-serif';
    const sym = String(l.symptom || ''); let cut = sym.length;
    while (cut > 0 && g.measureText(sym.slice(0, cut)).width > 290) cut--;
    g.fillText(sym.slice(0, cut), x, 188); g.fillText(fit(sym.slice(cut).trim(), 290), x, 222);
    g.fillText(fit(l.customer, 290), x, 268);
    g.font = '22px "Noto Sans Thai", sans-serif'; g.textAlign = 'center'; g.fillText('สแกนดูงาน/เพิ่มรูป', 133, 300);
    return c;
  }

  function drawCreated(d) {
    // เปิดจากเมนู "แจ้งงานซ่อม" ในแชทน้องจ๊อบ → แจ้งผล แล้วปิดหน้าเว็บกลับแชท (จ๊อบส่งการ์ดสรุปให้เป็นหลักฐาน · ผู้ใช้ 30 ต.ค. 2569)
    if (state.fromMenu && !d.attached && window.liff && liff.isInClient && liff.isInClient()) {
      state.fromMenu = false;
      let timer = 0;
      $app.innerHTML = '<div class="panel-box created"><div class="big-no">' + esc(d.no) + '</div><div>เปิดงานแล้ว</div><div class="actions"><a class="btn primary" href="#job/' +
        noDigits(d.no) + '">เปิดหน้างาน</a><a class="btn" href="#new">เปิดงานอื่น</a></div></div>';
      sheet('<div class="created-pop"><div class="pop-ok">✅</div><h2>เปิดงานเรียบร้อยแล้ว</h2><div class="big-no">' + esc(d.no) + '</div>' +
        '<p>' + (d.dm ? 'จ๊อบส่งการ์ดสรุปงานให้ในแชทแล้ว' : 'งานเปิดแล้ว (ส่งการ์ดในแชทไม่สำเร็จ ดูงานได้ที่บอร์ด)') + (d.card ? ' · ส่งการ์ดเข้ากลุ่มหลักแล้ว' : '') + '</p>' +
        (d.later && d.later.length ? '<p class="flag-due small">📝 ก่อนปิดงานต้องเติม: ' + esc(d.later.join(', ')) + '</p>' : '') +
        '<p class="muted small" id="back-note">กำลังกลับไปที่แชท…</p>' +
        '<div class="actions"><button class="btn primary" id="go-chat">กลับแชทเลย</button><a class="btn" href="#job/' + noDigits(d.no) + '">อยู่ต่อ ดูหน้างาน</a></div></div>', el => {
        el.querySelector('#go-chat').onclick = () => liff.closeWindow();
        el.querySelector('a.btn').onclick = () => { clearTimeout(timer); closeSheet(); };
      });
      timer = setTimeout(() => liff.closeWindow(), 2000);
      return;
    }
    $app.innerHTML = '<div class="panel-box created"><div class="big-no">' + esc(d.no) + '</div><div>' + (d.attached ? 'เพิ่มข้อมูลเข้างานแล้ว' : 'เปิดงานแล้ว') +
      (d.card ? ' · ส่งการ์ดเข้ากลุ่มแล้ว' : '') + (d.print ? ' · เข้าคิวพิมพ์ป้าย' : '') + '</div>' +
      '<div id="label-box"></div><div class="actions"><a class="btn primary" href="#job/' + noDigits(d.no) + '">เปิดหน้างาน</a>' +
      '<button class="btn" id="dl-label">ดาวน์โหลดป้าย QR</button><a class="btn" href="#new">เปิดงานอื่น</a></div>' +
      '<div class="muted small">ดาวน์โหลดป้ายแล้วเปิดในแอป NIIMBOT เพื่อพิมพ์ (ฉลาก 50×30 มม.) · ถ้ากดดาวน์โหลดไม่ได้ ให้กดค้างที่รูปแล้วบันทึก</div></div>';
    // ป๊อปอัป "เปิดงานเรียบร้อยแล้ว" (ผู้ใช้ขอ 26 ต.ค. 2569) · ปิดแล้วเห็นหน้าป้าย QR ด้านล่าง
    sheet('<div class="created-pop"><div class="pop-ok">✅</div><h2>' + (d.attached ? 'เพิ่มเข้างานเรียบร้อยแล้ว' : 'เปิดงานเรียบร้อยแล้ว') + '</h2>' +
      '<div class="big-no">' + esc(d.no) + '</div>' +
      (d.later && d.later.length && !d.attached ? '<p class="flag-due small">📝 ก่อนปิดงานต้องเติม: ' + esc(d.later.join(', ')) + ' (เข้าหน้างาน หรือสแกน QR ที่ป้าย)</p>' : '') +
      '<div class="actions"><button class="btn primary" data-close>ตกลง</button><a class="btn" href="#job/' + noDigits(d.no) + '">' +
      (d.later && d.later.length ? '📝 เพิ่มรายละเอียดงาน' : 'เปิดหน้างาน') + '</a></div></div>', el => {
      el.querySelector('a.btn').onclick = () => closeSheet();
    });
    if (typeof qrcode !== 'function') return;
    const c = labelCanvas(d.label, d.url);
    const img = new Image(); img.src = c.toDataURL('image/png'); img.className = 'label-img'; img.alt = 'ป้าย ' + d.no;
    document.getElementById('label-box').appendChild(img);
    document.getElementById('dl-label').onclick = () => { const a = document.createElement('a'); a.href = img.src; a.download = 'label-' + noDigits(d.no) + '.png'; a.click(); };
  }

  // ---------- ถอดอะไหล่ (Worker src/parts.js) ----------
  // ถอดอะไหล่จากเครื่องใหม่ไปใช้ก่อน → ต้องใส่คืนเมื่ออะไหล่มาถึง · เรียง ของมาแล้วรอใส่คืน → รอนานสุด
  const PART_LEVEL = { arrived: ['📦', 'ของมาแล้ว รอใส่คืน', 'lv-arrived'], red: ['🔴', 'เกิน 3 เดือน', 'lv-red'], orange: ['🟠', 'เกิน 2 เดือน', 'lv-orange'],
    yellow: ['🟡', 'เกิน 1 เดือน', 'lv-yellow'], normal: ['⚪', 'ยังไม่ถึงเดือน', 'lv-normal'] };
  const partDonor = p => [p.donorProduct, p.donorSerial && 'SN ' + p.donorSerial].filter(Boolean).join(' ');
  const partName = p => p.part + (p.qty && p.qty !== '1' ? ' ×' + p.qty : '');
  const fmtMs = t => fmtDate(new Date(t).toISOString());

  function setPartsBadge(n) {
    const b = document.getElementById('parts-badge');
    if (!b) return;
    b.textContent = n; b.hidden = !n;
  }

  async function renderParts() {
    setTab('parts');
    const live = claim();
    state.partsView = state.partsView || 'open';
    if (!state.parts) $app.innerHTML = '<div class="center muted">กำลังโหลด…</div>'; else drawParts();
    const data = await core('parts');
    if (!live()) return;
    state.parts = data;
    setPartsBadge(data.open.filter(p => p.level !== 'normal').length);
    drawParts();
  }

  function drawParts(listOnly) {
    const d = state.parts, q = (state.partsQ || '').trim().toLowerCase();
    const match = p => !q || [p.no, p.part, p.donorProduct, p.donorSerial, p.job, p.customer, p.by].join(' ').toLowerCase().includes(q);
    const seg = (k, l) => '<button class="seg' + (state.partsView === k ? ' on' : '') + '" data-pv="' + k + '">' + l + '</button>';
    let html = '<div class="review-head"><div class="segs">' + seg('open', 'ยังไม่ใส่คืน (' + d.open.length + ')') + seg('closed', 'ปิดแล้ว') + '</div>' +
      '<a class="btn primary" href="#part-new">＋ บันทึกถอดอะไหล่</a></div>' +
      '<input class="search" id="pq" type="search" placeholder="ค้นชื่ออะไหล่ รุ่น SN เลขงาน ลูกค้า" value="' + esc(state.partsQ || '') + '">';
    const head = html;
    html = '';
    const card = p => '<a class="card part-card ' + PART_LEVEL[p.level][2] + '" href="#part/' + p.id + '"><div class="top"><span class="no">' + esc(p.no) + '</span><span class="title">' +
      esc(partName(p)) + '</span><span class="age">' + (p.status === 'อะไหล่มาแล้ว' ? 'มาแล้ว' : p.status === 'รออะไหล่' ? p.days + ' วัน' : esc(p.status)) + '</span></div>' +
      '<div class="meta"><span>จาก ' + esc(partDonor(p) || '-') + '</span>' + (p.job ? '<span>→ ' + esc(p.job) + '</span>' : '') + (p.customer ? '<span>' + esc(p.customer) + '</span>' : '') +
      '<span>ถอด ' + esc(fmtMs(p.time)) + ' · ' + esc(p.by) + '</span></div></a>';
    if (state.partsView === 'closed') {
      const list = d.closed.filter(match);
      html += list.length ? list.map(card).join('') : '<div class="center muted">ยังไม่มีรายการที่ปิด</div>';
    } else {
      const list = d.open.filter(match);
      if (!list.length) html += '<div class="center"><p>✅ ไม่มีอะไหล่ค้างใส่คืน</p></div>';
      ['arrived', 'red', 'orange', 'yellow', 'normal'].forEach(lv => {
        const g = list.filter(p => p.level === lv);
        if (!g.length) return;
        html += '<section class="group"><h3 class="group-head">' + PART_LEVEL[lv][0] + ' ' + PART_LEVEL[lv][1] + ' (' + g.length + ')</h3>' + g.map(card).join('') + '</section>';
      });
    }
    const listEl = document.getElementById('parts-list');
    if (listOnly && listEl) { listEl.innerHTML = html; return; }
    $app.innerHTML = head + '<div id="parts-list">' + html + '</div>';
    $app.querySelectorAll('[data-pv]').forEach(b => b.onclick = () => { state.partsView = b.dataset.pv; drawParts(); });
    const input = document.getElementById('pq');
    input.oninput = () => { state.partsQ = input.value; drawParts(true); };
  }

  async function renderPart(id) {
    setTab('parts');
    const live = claim();
    $app.innerHTML = '<div class="center muted">กำลังโหลด…</div>';
    const data = await core('part', { id });
    if (live()) drawPart(data);
  }

  function drawPart(data) {
    const p = data.part;
    const lv = PART_LEVEL[p.level];
    const open = p.status === 'รออะไหล่' || p.status === 'อะไหล่มาแล้ว';
    let html = '<a class="back" href="#parts">‹ ถอดอะไหล่</a><div class="job-head"><h1>' + esc(p.no) + ' ' + esc(partName(p)) + '</h1>' +
      '<div class="sub"><span class="pill ' + lv[2] + '">' + esc(p.status) + '</span>' + (open && p.status === 'รออะไหล่' ? ' ' + lv[0] + ' รอมา ' + p.days + ' วัน' : '') + '</div></div>' +
      '<div class="panel-box part-info">' +
      '<div><span class="muted">ถอดจาก</span> <b>' + esc(partDonor(p) || '-') + '</b></div>' +
      '<div><span class="muted">ให้งาน</span> ' + (p.job ? '<a href="#job/' + noDigits(p.job) + '">' + esc(p.job) + '</a>' : '-') + (p.customer ? ' · ' + esc(p.customer) : '') + (p.province ? ' จ.' + esc(p.province) : '') + '</div>' +
      (p.phone ? '<div><span class="muted">เบอร์</span> <a href="tel:' + esc(p.phone) + '">' + esc(p.phone) + '</a></div>' : '') +
      (p.purpose ? '<div><span class="muted">ใช้ทำ</span> ' + esc(p.purpose) + '</div>' : '') +
      '<div><span class="muted">ถอดเมื่อ</span> ' + esc(fmtMs(p.time)) + ' โดย ' + esc(p.by) + '</div>' +
      (p.arrivedAt ? '<div><span class="muted">อะไหล่มา</span> ' + esc(fmtMs(p.arrivedAt)) + (p.arrivedBy ? ' (' + esc(p.arrivedBy) + ')' : '') + '</div>' : '') +
      (p.doneAt ? '<div><span class="muted">ใส่คืน</span> ' + esc(fmtMs(p.doneAt)) + ' โดย ' + esc(p.doneBy) + '</div>' : '') +
      (p.note ? '<div><span class="muted">โน้ต</span> ' + esc(p.note) + '</div>' : '') + '</div>';
    if (data.files.length) html += '<div class="files">' + data.files.map(f => '<div class="file" data-pkey="' + esc(f.key) + '" data-url="' + esc(f.url) + '">' +
      (f.url ? '<img src="' + esc(f.url) + '" alt="">' : '<div class="vid small">📦 NAS<br>แตะดึง</div>') + '</div>').join('') + '</div>';
    html += '<div class="actions"><button class="btn" id="p-edit">✏️ แก้ไขรายละเอียด</button>' +
      (open ? '<button class="btn" id="p-reprint">🖨️ พิมพ์ป้ายซ้ำ</button>' : '') +
      (p.status === 'รออะไหล่' ? '<button class="btn primary" data-to="arrived">📦 อะไหล่มาแล้ว</button>' : '') +
      (open ? '<button class="btn' + (p.status === 'อะไหล่มาแล้ว' ? ' primary' : '') + '" data-to="done">✅ ใส่คืนแล้ว</button><button class="btn danger" data-to="cancel">ยกเลิกรายการ</button>'
        : '<button class="btn" data-to="reopen">↩︎ เปิดใหม่</button>') + '</div>';
    html += '<div class="note-box"><textarea id="note" placeholder="บันทึกโน้ต เช่น สั่งอะไหล่แล้ว PO 123 คาดว่ามา 15 พ.ย."></textarea><button class="btn primary" id="save-note">บันทึก</button></div>';
    const timeline = data.events.concat(data.msgs || []).sort((a, b) => a.time - b.time);
    html += '<h3>ไทม์ไลน์</h3><ul class="timeline">' + timeline.map(ev => ev.msg ? eventHtml(ev) : '<li class="' + (ev.kind === 'ใส่คืนแล้ว' ? 'k-fix' : ev.kind === 'อะไหล่มาแล้ว' ? 'k-status' : ev.kind === 'ถอด' ? 'k-open' : '') +
      '"><div class="when">' + esc(fmtDateTime(new Date(ev.time).toISOString())) + '</div><div class="what">' + esc(ev.kind) + ' <span class="muted small">โดย ' + esc(ev.by) + '</span></div>' +
      (ev.detail ? '<div class="text">' + esc(ev.detail) + '</div>' : '') + '</li>').join('') + '</ul>';
    if (!(data.msgs || []).length) html += '<p class="muted small">มีคุยเรื่องอะไหล่นี้ในกลุ่ม → คิวตรวจ กด "📎 แนบงานเดิม" แล้วเลือก ' + esc(p.no) + '</p>';
    $app.innerHTML = html;
    loadThumbs();
    $app.querySelectorAll('[data-media]').forEach(el => el.onclick = () => openMedia({ msgId: el.dataset.media, type: el.dataset.mtype, full: el.dataset.full }));
    $app.querySelectorAll('[data-pkey]').forEach(el => el.onclick = () => openMedia({ key: el.dataset.pkey, type: /\.(mp4|mov)$/.test(el.dataset.pkey) ? 'video' : 'image', full: el.dataset.url }));
    const TITLE = { arrived: '📦 อะไหล่มาแล้ว', done: '✅ ใส่อะไหล่คืนเครื่องแล้ว', cancel: 'ยกเลิกรายการ', reopen: 'เปิดรายการใหม่' };
    const HINT = { arrived: 'จ๊อบจะทักบอก ' + p.by + ' ให้ไปเบิกจากสโตร์มาใส่คืน', done: 'ใส่คืนที่ ' + partDonor(p) + ' แล้ว (เครื่องนี้ขายได้แล้ว)',
      cancel: 'เช่น บันทึกผิด / ลูกค้าคืนอะไหล่แล้วใส่คืนทันที', reopen: '' };
    $app.querySelectorAll('[data-to]').forEach(b => b.onclick = () => sheet('<h2>' + TITLE[b.dataset.to] + '</h2><p class="muted small">' + esc(HINT[b.dataset.to]) + '</p>' +
      '<label class="field">' + (b.dataset.to === 'cancel' ? 'เหตุผล <b class="req">*</b>' : 'โน้ต (ไม่บังคับ)') + '<textarea id="f-note" rows="2" maxlength="500"></textarea></label>' +
      '<div class="actions"><button class="btn primary" id="f-ok">บันทึก</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      el.querySelector('#f-ok').onclick = e => partAction(e.target, p.id, b.dataset.to, el.querySelector('#f-note').value.trim());
    }));
    document.getElementById('save-note').onclick = e => {
      const note = document.getElementById('note').value.trim();
      if (note) partAction(e.target, p.id, 'note', note);
    };
    document.getElementById('p-edit').onclick = () => partEditSheet(p);
    const rp = document.getElementById('p-reprint');
    if (rp) rp.onclick = e => reprintLabel(e.target, { partId: p.id });
  }

  // แก้รายละเอียดทีหลัง (รู้ชื่อลูกค้า / เลขงาน / เบอร์ / จังหวัดภายหลัง) · Worker บันทึกสิ่งที่เปลี่ยนลงไทม์ไลน์
  function partEditSheet(p) {
    const f = (name, label, val, extra) => '<label class="field"><span class="lbl">' + label + '</span><input name="' + name + '" value="' + esc(val || '') + '"' + (extra || '') + '></label>';
    sheet('<h2>✏️ แก้ไข ' + esc(p.no) + '</h2><form id="pe" autocomplete="off">' +
      f('part', 'อะไหล่ที่ถอด', p.part) +
      f('donorProduct', 'รุ่นเครื่องที่ถอด', p.donorProduct, ' list="plist3"') + '<datalist id="plist3">' + PRODUCT_HINTS.map(x => '<option value="' + esc(x) + '">').join('') + '</datalist>' +
      f('donorSerial', 'SN เครื่องที่ถอด', p.donorSerial) +
      f('jobNo', 'เลขงานซ่อม', noDigits(p.job || ''), ' inputmode="numeric" placeholder="เช่น 131 (ว่าง = ไม่ผูกงาน)"') +
      f('customer', 'ชื่อลูกค้า', p.customer) +
      f('phone', 'เบอร์ลูกค้า', p.phone, ' type="tel" inputmode="tel"') +
      '<label class="field"><span class="lbl">จังหวัด</span><select name="province"><option value=""></option>' +
        PROVINCES.map(x => '<option' + (x === p.province ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select></label>' +
      '<div class="actions"><button class="btn primary" id="pe-ok">บันทึก</button><button type="button" class="btn" data-close>ยกเลิก</button></div></form>', el => {
      el.querySelector('#pe').onsubmit = async e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const part = {};
        ['part', 'donorProduct', 'donorSerial', 'jobNo', 'customer', 'phone', 'province'].forEach(k => { part[k] = String(fd.get(k) || '').trim(); });
        busy(el.querySelector('#pe-ok'));
        try {
          const out = await core('updatePart', { id: p.id, part });
          closeSheet();
          toast(out.changed ? 'แก้ไขแล้ว ' + out.changed + ' ช่อง ✅' : 'ไม่มีอะไรเปลี่ยน');
          state.parts = null;
          drawPart(await core('part', { id: p.id }));
        } catch (err) { if (err.message !== 'login') toast(err.message); unbusy(); }
      };
    });
  }

  async function partAction(btn, id, to, note) {
    if (to === 'cancel' && !note) return toast(CORE_ERRORS.no_note);
    busy(btn);
    try {
      await core('setPart', { id, to, note });
      closeSheet();
      toast({ arrived: 'บันทึกแล้ว จ๊อบแจ้งช่างที่ถอดให้แล้ว ✅', done: 'ใส่คืนแล้ว ✅', cancel: 'ยกเลิกแล้ว', reopen: 'เปิดใหม่แล้ว', note: 'บันทึกโน้ตแล้ว' }[to]);
      state.parts = null;
      drawPart(await core('part', { id }));
    } catch (err) { if (err.message !== 'login') toast(err.message); unbusy(); }
  }

  const partForm = { files: [] }; // ฟอร์มที่กรอกค้างไว้
  function renderPartNew(jobNo) {
    setTab('parts');
    claim();
    const v = partForm;
    if (jobNo && !v.jobNo) v.jobNo = jobNo;
    $app.innerHTML = '<a class="back" href="#parts">‹ ถอดอะไหล่</a><h1>🔧 บันทึกถอดอะไหล่</h1>' +
      '<p class="muted small">ถอดอะไหล่จากเครื่องใหม่ไปใช้ก่อน → จ๊อบปริ้นป้าย "ห้ามขาย" ให้แปะเครื่อง และเตือนจนกว่าจะใส่คืน</p>' +
      (v.fromReview ? '<div class="panel-box"><b>จากคิวตรวจ ' + v.fromReview.length + ' ข้อ</b><div class="small" style="white-space:pre-wrap">' + esc(v.reviewText) + '</div>' +
        '<div class="muted small">บันทึกแล้ว ข้อนี้ออกจากคิวเอง (มีเลขงาน = แนบเข้างานนั้น · ไม่มี = ไม่เกี่ยวกับงานซ่อม)</div></div>' : '') +
      '<form id="pf" class="intake" autocomplete="off">' +
      '<label class="field"><span class="lbl">1. อะไหล่ที่ถอด <b class="req">*</b></span><input name="part" placeholder="เรียกตามที่เข้าใจ เช่น ปั๊มไฮดรอลิก" value="' + esc(v.part || '') + '"></label>' +
      '<div class="field"><span class="lbl">2. รูปอะไหล่</span><div class="files" id="pfiles"></div>' +
      '<label class="btn"><input type="file" id="ppick" accept="image/*" multiple hidden>＋ ถ่าย / เลือกรูป</label></div>' +
      '<label class="field"><span class="lbl">3. ถอดจากเครื่องใหม่รุ่น</span><input name="donorProduct" list="plist2" value="' + esc(v.donorProduct || '') + '"><datalist id="plist2">' +
        PRODUCT_HINTS.map(x => '<option value="' + esc(x) + '">').join('') + '</datalist></label>' +
      '<div class="field"><span class="lbl">SN เครื่องที่ถอด <b class="req">*</b> (ป้ายเลือนพิมพ์ "ป้ายชำรุด" · ไม่มีป้ายพิมพ์ "ไม่มี SN")</span><input name="donorSerial" value="' + esc(v.donorSerial || '') + '">' +
        '<label class="btn"><input type="file" id="pplate" accept="image/*" capture="environment" hidden>📷 ถ่ายป้ายเครื่องให้ AI อ่าน SN</label><div class="muted small" id="pplate-out"></div></div>' +
      '<label class="field"><span class="lbl">4. ของงานไหน: เลขงานซ่อม</span><input name="jobNo" inputmode="numeric" placeholder="เช่น 131" value="' + esc(v.jobNo || '') + '"></label>' +
      '<div class="muted small">หรือ ถ้าไม่มีเลขงาน</div>' +
      '<label class="field"><span class="lbl">ชื่อลูกค้า</span><input name="customer" value="' + esc(v.customer || '') + '"></label>' +
      '<label class="field"><span class="lbl">เบอร์ลูกค้า (ถ้ามี)</span><input name="phone" type="tel" inputmode="tel" value="' + esc(v.phone || '') + '"></label>' +
      '<label class="field"><span class="lbl">จังหวัด</span><select name="province"><option value=""></option>' +
        PROVINCES.map(x => '<option' + (x === v.province ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select></label>' +
      '<label class="check"><input type="checkbox" name="print"' + (v.print === false ? '' : ' checked') + '> ปริ้นป้าย "ห้ามขาย" แปะเครื่องที่ถอด</label>' +
      '<button class="btn primary wide" id="psubmit">บันทึกถอดอะไหล่</button></form>';
    const form = document.getElementById('pf');
    const keep = () => { const fd = new FormData(form); ['part', 'donorProduct', 'donorSerial', 'jobNo', 'customer', 'phone', 'province'].forEach(k => { partForm[k] = fd.get(k); });
      partForm.print = form.print.checked; };
    form.oninput = keep; form.onchange = keep;
    const drawPF = () => {
      const el = document.getElementById('pfiles');
      if (!el) return;
      el.innerHTML = partForm.files.map((f, i) => '<div class="file">' + (f.url && f.type !== 'video' ? '<img src="' + esc(f.url) + '" alt="">' : '<div class="vid">' + (f.type === 'video' ? '🎬' : '🖼️') + '</div>') +
        (f.state ? '<span class="fstate' + (f.error ? ' bad' : '') + '">' + esc(f.state) + '</span>' : '') +
        '<button type="button" class="fdel" data-i="' + i + '" aria-label="ลบ">✕</button></div>').join('');
      el.querySelectorAll('.fdel').forEach(b => b.onclick = () => { partForm.files.splice(Number(b.dataset.i), 1); drawPF(); });
    };
    const add = file => {
      const item = { url: URL.createObjectURL(file), state: 'กำลังส่ง' };
      partForm.files.push(item); drawPF();
      uploadFile(file).then(k => { item.key = k; item.state = ''; }).catch(err => { item.state = 'ส่งไม่สำเร็จ'; item.error = true; toast(err.message); }).then(drawPF);
    };
    drawPF();
    window.partDrawFiles = drawPF; // รูปจากแชท (คิวตรวจ) ดึงเสร็จทีหลัง
    document.getElementById('ppick').onchange = e => { [...e.target.files].forEach(add); e.target.value = ''; };
    document.getElementById('pplate').onchange = async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      add(f);
      const out = document.getElementById('pplate-out');
      out.textContent = 'AI กำลังอ่านป้าย…';
      try {
        const r = await core('readPlate', { image: await toDataUrl(await shrink(f, 1600)), mime: 'image/jpeg' });
        if (!r.serial) { out.textContent = '⚠️ AI อ่านเลขไม่ได้ ถ่ายป้ายให้ชัดขึ้น หรือพิมพ์เอง'; return; }
        form.donorSerial.value = r.damaged ? 'ป้ายชำรุด ' + r.serial : r.serial;
        const model = r.product && r.model && !r.product.includes(r.model) ? r.product + ' ' + r.model : r.product || r.model;
        if (!form.donorProduct.value && model) form.donorProduct.value = model;
        keep();
        out.textContent = (r.damaged ? '🏷️ ป้ายชำรุด อ่านได้บางส่วน ' : '✅ AI อ่านได้ ') + r.serial + ' — ตรวจว่าตรงป้าย';
      } catch (err) { if (err.message !== 'login') out.textContent = '⚠️ ' + err.message; }
    };
    form.onsubmit = async e => {
      e.preventDefault();
      keep();
      if (partForm.files.some(f => f.state === 'กำลังส่ง' || f.loading)) return toast('รอส่ง/ดึงรูปให้เสร็จก่อน');
      if (!String(partForm.part || '').trim()) return toast(CORE_ERRORS.no_part);
      if (!String(partForm.donorSerial || '').trim()) return toast(CORE_ERRORS.no_donor_serial);
      if (!String(partForm.jobNo || '').trim() && !String(partForm.customer || '').trim()) return toast(CORE_ERRORS.no_target);
      if (!String(partForm.jobNo || '').trim() && !partForm.province) return toast('เลือกจังหวัดของลูกค้า');
      const btn = document.getElementById('psubmit');
      busy(btn);
      try {
        const out = await core('createPart', { part: Object.assign({}, partForm, { files: partForm.files.filter(f => f.key).map(f => f.key),
          note: partForm.reviewText ? 'จากแชทกลุ่ม: ' + partForm.reviewText : '' }) });
        if (partForm.fromReview) { // ข้อในคิวตรวจที่มาจากแชทนี้ → เข้ารายการใหม่ (รายการผูกงาน = เข้างานนั้นด้วย) · บันทึกเบื้องหลัง
          const items = partForm.fromReview;
          queueSave(items, () => api('decideMany', { items, decision: 'part', part: out.no, status: '' }), () => 'คิวตรวจ: แนบข้อความเข้า ' + out.no);
        }
        partForm.files.forEach(f => URL.revokeObjectURL(f.url));
        Object.keys(partForm).forEach(k => delete partForm[k]); partForm.files = [];
        state.parts = null;
        toast('บันทึก ' + out.no + ' แล้ว' + (out.print ? ' · ส่งปริ้นป้ายแล้ว' : '') + ' ✅');
        location.hash = '#part/' + out.id;
      } catch (err) { if (err.message !== 'login') toast(err.message); unbusy(); }
    };
  }

  // ---------- สินค้า (รายการที่ AI ใช้ระบุเครื่อง + รูปตัวอย่างต่อรุ่น · ผู้ใช้ 24/26 ต.ค. 2569) ----------
  // ห้ามทำให้ระบบช้า: โหลดเฉพาะตอนเปิดแท็บนี้ · รูปเล็ก lazy · ข้อมูลเก็บใน state ไว้วาดซ้ำทันที
  const SUG_KIND = { alias: 'คำเรียกใหม่', model: 'รุ่นใหม่', new: 'สินค้าใหม่' };
  async function renderProducts() {
    setTab('products');
    const live = claim();
    if (state.products) drawProducts(); else $app.innerHTML = '<div class="center muted">กำลังโหลด…</div>';
    const data = await core('products');
    if (!live()) return;
    state.products = data;
    drawProducts();
  }

  function drawProducts(listOnly) {
    const d = state.products, q = (state.prodQ || '').trim().toLowerCase();
    let html = '<div class="review-head"><h1 class="h-inline">สินค้า</h1><button class="btn primary" id="pr-new">＋ เพิ่มสินค้า</button></div>' +
      '<p class="muted small">รายการนี้ AI ใช้ระบุเครื่องในแชท รูป และการเปิดงาน · เพิ่มคำที่ทีมเรียก รุ่นใหม่ และรูปตัวอย่างต่อรุ่น AI จะแม่นขึ้น</p>';
    if (d.suggestions.length) {
      html += '<section class="panel-box sug-box"><b>🤖 AI เสนอจากงานจริง (' + d.suggestions.length + ')</b><p class="muted small">กดรับก่อนถึงจะเพิ่มเข้ารายการ · แก้คำก่อนรับได้</p>' +
        d.suggestions.map(x => '<div class="sug-row"><div><span class="tag">' + SUG_KIND[x.kind] + '</span> ' + (x.product ? esc(x.product) + ' → ' : '') +
          '<input class="sug-val" data-sv="' + x.id + '" value="' + esc(x.value) + '" maxlength="80"><div class="muted small">' + esc(x.reason) + (x.jobs ? ' · ' + esc(x.jobs) : '') + '</div></div>' +
          '<div class="actions"><button class="btn primary" data-sug="' + x.id + '" data-ok="1">✓ รับ</button><button class="btn" data-sug="' + x.id + '">✗ ไม่รับ</button></div></div>').join('') + '</section>';
    }
    html += '<input class="search" id="prq" type="search" placeholder="ค้นชื่อ รุ่น หรือคำเรียก" value="' + esc(state.prodQ || '') + '">';
    const list = d.products.filter(p => !q || [p.name, p.models.join(' '), p.aliases.join(' ')].join(' ').toLowerCase().includes(q));
    const listHtml = list.map(p => '<a class="card prod-card" href="#product/' + p.id + '">' +
      (p.cover ? '<img loading="lazy" src="' + esc(p.cover) + '" alt="">' : '<div class="prod-noimg">📷</div>') +
      '<div><div class="title">' + esc(p.name) + '</div>' + (p.models.length ? '<div class="small">' + esc(p.models.join(' · ')) + '</div>' : '') +
      '<div class="muted small">' + (p.aliases.length ? 'คนเรียก: ' + esc(p.aliases.join(', ')) + ' · ' : '') + 'รูปตัวอย่าง ' + p.images + '</div></div></a>').join('') ||
      '<div class="center muted">ไม่พบสินค้า</div>';
    const listEl = document.getElementById('prod-list');
    if (listOnly && listEl) { listEl.innerHTML = listHtml; return; }
    html += '<div id="prod-list">' + listHtml + '</div>';
    html += '<div class="center"><button class="btn" id="pr-learn">🤖 ให้ AI หาคำเรียก/รุ่นใหม่จากงานตอนนี้</button>' +
      (d.learnedAt ? '<p class="muted small">AI ดูงานล่าสุดเมื่อ ' + esc(fmtMs(d.learnedAt)) + ' (ดูเองสัปดาห์ละครั้ง)</p>' : '') + '</div>';
    $app.innerHTML = html;
    document.getElementById('pr-new').onclick = () => productSheet(null);
    const input = document.getElementById('prq');
    input.oninput = () => { state.prodQ = input.value; drawProducts(true); };
    $app.querySelectorAll('[data-sug]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      const val = $app.querySelector('[data-sv="' + b.dataset.sug + '"]').value.trim();
      try { state.products = await core('decideSuggestion', { id: Number(b.dataset.sug), accept: !!b.dataset.ok, value: val }); drawProducts(); toast(b.dataset.ok ? 'เพิ่มเข้ารายการแล้ว ✅' : 'ไม่รับ (AI จะไม่เสนอซ้ำ)'); }
      catch (err) { b.disabled = false; if (err.message !== 'login') toast('⚠️ ' + err.message); }
    });
    document.getElementById('pr-learn').onclick = async e => {
      e.target.disabled = true; e.target.textContent = '🤖 AI กำลังดูงานล่าสุด… (ราว 20–40 วินาที)';
      try {
        const out = await core('learnProducts');
        state.products = out; drawProducts();
        toast(out.added ? 'AI เสนอมา ' + out.added + ' ข้อ ดูด้านบน' : out.skipped === 'budget' ? 'วันนี้ใช้งบ AI ครบแล้ว' : 'AI ไม่เจออะไรใหม่');
      } catch (err) { if (err.message !== 'login') toast('⚠️ ' + err.message); drawProducts(); }
    };
  }

  async function renderProduct(id) {
    setTab('products');
    const live = claim();
    $app.innerHTML = '<div class="center muted">กำลังโหลด…</div>';
    const data = await core('product', { id: Number(id) });
    if (live()) drawProduct(data);
  }

  function drawProduct(data) {
    const p = data.product;
    let html = '<a class="back" href="#products">‹ สินค้า</a><div class="job-head"><h1>' + esc(p.name) + '</h1></div>' +
      '<div class="panel-box info-box"><div class="row"><b>ข้อมูลที่ AI ใช้</b><button class="btn" id="pd-edit">✏️ แก้ไข</button></div>' +
      [['รุ่น', p.models.join(' · ')], ['คนเรียก', p.aliases.join(', ')], ['SN / ป้าย', p.sn_hint], ['ลักษณะ / อาการบ่อย', p.notes]]
        .map(([l, v]) => '<div class="info-row"><span class="muted">' + l + '</span><span' + (v ? '' : ' class="muted"') + '>' + esc(v || '—') + '</span></div>').join('') +
      (p.updated ? '<div class="muted small">แก้ล่าสุด ' + esc(fmtMs(p.updated)) + ' · ' + esc(p.updatedBy) + '</div>' : '') + '</div>';
    html += '<div class="panel-box"><b>รูปตัวอย่าง (' + data.images.length + ')</b><p class="muted small">ถ่ายหลายมุม + ป้ายรุ่น · AI ดูเฉพาะตอนอ่านรูปแล้วไม่แน่ใจว่ารุ่นไหน · ' +
      'ใช้รูปจากงานได้: เปิดรูปในหน้างาน กด "⭐ ใช้เป็นรูปตัวอย่างสินค้า"</p>' +
      '<label class="field"><span class="lbl">รุ่นของรูปที่จะเพิ่ม</span><select id="pd-model"><option value="">(ทุกรุ่น / ไม่ระบุ)</option>' +
      p.models.map(m => '<option>' + esc(m) + '</option>').join('') + '</select></label>' +
      '<label class="btn"><input type="file" id="pd-pick" accept="image/*" multiple hidden>📷 ถ่าย / เลือกรูป</label>';
    const groups = {};
    data.images.forEach(i => { (groups[i.model] = groups[i.model] || []).push(i); });
    Object.keys(groups).sort().forEach(m => {
      html += '<div class="small" style="margin-top:10px"><b>' + esc(m || 'ไม่ระบุรุ่น') + '</b></div><div class="files">' + groups[m].map(i =>
        '<div class="file" data-pimg="' + i.id + '" data-url="' + esc(i.url) + '"><img loading="lazy" src="' + esc(i.thumb) + '" alt=""><button class="fdel" data-pdel="' + i.id + '" aria-label="ลบ">✕</button></div>').join('') + '</div>';
    });
    html += '</div><div class="center"><button class="btn" id="pd-hide">🗑️ เอาสินค้านี้ออกจากรายการ</button></div>';
    $app.innerHTML = html;
    document.getElementById('pd-edit').onclick = () => productSheet(data);
    $app.querySelectorAll('[data-pimg]').forEach(el => el.onclick = e => { if (!e.target.dataset.pdel) openMedia({ type: 'image', full: el.dataset.url }); });
    $app.querySelectorAll('[data-pdel]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      if (!confirm('ลบรูปตัวอย่างนี้?')) return;
      try { drawProduct(await core('deleteProductImage', { imageId: Number(b.dataset.pdel) })); state.products = null; } catch (err) { if (err.message !== 'login') toast('⚠️ ' + err.message); }
    });
    document.getElementById('pd-pick').onchange = async e => {
      const picked = [...e.target.files];
      e.target.value = '';
      if (!picked.length) return;
      const model = document.getElementById('pd-model').value;
      toast('กำลังส่งรูป ' + picked.length + ' รูป…');
      try {
        const files = [];
        for (const f of picked) files.push({ key: await uploadFile(f, 1024), thumb: await uploadFile(f, 240) });
        drawProduct(await core('addProductImages', { id: p.id, model, files }));
        state.products = null;
        toast('เพิ่มรูปตัวอย่างแล้ว ✅');
      } catch (err) { if (err.message !== 'login') toast('⚠️ ' + err.message); }
    };
    document.getElementById('pd-hide').onclick = async () => {
      if (!confirm('เอา "' + p.name + '" ออกจากรายการ? (AI จะไม่ใช้ชื่อนี้แล้ว)')) return;
      try { await core('deleteProduct', { id: p.id }); state.products = null; location.hash = '#products'; } catch (err) { if (err.message !== 'login') toast('⚠️ ' + err.message); }
    };
  }

  function productSheet(data) {
    const p = data ? data.product : { name: '', models: [], aliases: [], sn_hint: '', notes: '' };
    const fld = (id, label, inner) => '<label class="field"><span class="lbl">' + label + '</span>' + inner + '</label>';
    sheet('<h2>' + (data ? 'แก้ ' + esc(p.name) : 'เพิ่มสินค้า') + '</h2>' +
      fld('n', 'ชื่อสินค้า / ประเภท', '<input id="p-name" maxlength="80" value="' + esc(p.name) + '" placeholder="เช่น เครื่องดัดเหล็ก">') +
      fld('m', 'รุ่น (คั่นด้วย , )', '<textarea id="p-models" rows="2" maxlength="400" placeholder="นิวตัน 25, นิวตัน 32">' + esc(p.models.join(', ')) + '</textarea>') +
      fld('a', 'คำที่ทีมเรียก (คั่นด้วย , )', '<textarea id="p-aliases" rows="2" maxlength="300" placeholder="ดัด25, ดัด32">' + esc(p.aliases.join(', ')) + '</textarea>') +
      fld('s', 'SN / ป้าย (รูปแบบเลข ที่อยู่ป้าย)', '<input id="p-sn" maxlength="120" value="' + esc(p.sn_hint) + '">') +
      fld('o', 'ลักษณะ / อาการที่เจอบ่อย', '<textarea id="p-notes" rows="2" maxlength="400">' + esc(p.notes) + '</textarea>') +
      '<div class="actions"><button class="btn primary" id="p-ok">บันทึก</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      el.querySelector('#p-ok').onclick = async e => {
        busy(e.target);
        try {
          const out = await core('saveProduct', { id: data ? p.id : 0, name: el.querySelector('#p-name').value, models: el.querySelector('#p-models').value,
            aliases: el.querySelector('#p-aliases').value, sn_hint: el.querySelector('#p-sn').value, notes: el.querySelector('#p-notes').value });
          closeSheet(); state.products = null;
          if (data) drawProduct(out); else location.hash = '#product/' + out.product.id;
          toast('บันทึกแล้ว ✅ AI ใช้รายการใหม่ภายใน 5 นาที');
        } catch (err) { unbusy(); if (err.message !== 'login') toast('⚠️ ' + err.message); }
      };
    });
  }

  /** รูปในหน้างาน → รูปตัวอย่างของสินค้า (เลือกสินค้า + รุ่น) */
  async function refPickSheet(from) {
    let list;
    try { list = (state.products || (state.products = await core('products'))).products; } catch (err) { if (err.message !== 'login') toast('⚠️ ' + err.message); return; }
    sheet('<h2>⭐ ใช้เป็นรูปตัวอย่างสินค้า</h2><label class="field"><span class="lbl">สินค้า</span><select id="r-p">' +
      list.map(p => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('') + '</select></label>' +
      '<label class="field"><span class="lbl">รุ่น</span><select id="r-m"></select></label>' +
      '<div class="actions"><button class="btn primary" id="r-ok">เพิ่มรูป</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      const sel = el.querySelector('#r-p'), mod = el.querySelector('#r-m');
      const fill = () => { const p = list.find(x => String(x.id) === sel.value); mod.innerHTML = '<option value="">(ไม่ระบุรุ่น)</option>' + (p ? p.models.map(m => '<option>' + esc(m) + '</option>').join('') : ''); };
      sel.onchange = fill; fill();
      el.querySelector('#r-ok').onclick = async e => {
        busy(e.target);
        try { await core('addProductImages', { id: Number(sel.value), model: mod.value, from }); state.products = null; closeSheet(); toast('เพิ่มเป็นรูปตัวอย่างแล้ว ✅'); }
        catch (err) { unbusy(); if (err.message !== 'login') toast('⚠️ ' + err.message); }
      };
    });
  }

  // ---------- เส้นทาง ----------
  async function route() {
    closeSheet();
    { const v = document.getElementById('viewer'); if (v) { v.hidden = true; v.innerHTML = ''; } }
    if (location.hash !== '#review') { const bar = document.getElementById('bulkbar'); if (bar) bar.remove(); }
    { const mv = document.getElementById('movebar'); if (mv) mv.remove(); }
    const hash = location.hash || '#board';
    try {
      const m = hash.match(/^#job\/(\d+)/);
      const pm = hash.match(/^#part\/(\d+)/);
      const pn = hash.match(/^#part-new(?:\/(\d+))?$/);
      if (m) await renderJob(m[1]);
      else if (pm) await renderPart(pm[1]);
      else if (pn) renderPartNew(pn[1] || '');
      else if (hash === '#parts') await renderParts();
      else if (hash === '#products') await renderProducts();
      else if (/^#product\/\d+$/.test(hash)) await renderProduct(hash.split('/')[1]);
      else if (hash === '#review') await renderReview();
      else if (hash === '#stats') await renderStats();
      else if (hash === '#new') { claim(); renderNew(); }
      else if (hash === '#search') await renderSearch();
      else await renderBoard();
      window.scrollTo(0, 0);
    } catch (err) {
      if ((location.hash || '#board') === hash) showError(err); // error ของหน้าที่ผู้ใช้ออกไปแล้ว ไม่ต้องแสดง
    }
  }

  // body เว้นที่ด้านบนเท่าแถบแท็บจริง (แถบสูงเปลี่ยนได้ตามขนาดตัวอักษร / ขอบจอ)
  function fitTopbar() {
    const bar = document.querySelector('.topbar');
    if (bar) document.documentElement.style.setProperty('--topbar-h', bar.offsetHeight + 'px');
  }
  fitTopbar();
  window.addEventListener('resize', fitTopbar);
  // กันแถบแท็บหลุดจากจอหลังคีย์บอร์ดปิด (iPhone เลื่อนจอที่มองเห็นค้างไว้ ไม่ตรงกับหน้าเว็บ):
  // เลื่อนแถบตามจอที่มองเห็นจริง และตอนออกจากช่องพิมพ์ให้จอกลับเข้าที่
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const follow = () => {
      const bar = document.querySelector('.topbar');
      if (bar) bar.style.transform = vv.offsetTop > 0 ? 'translateY(' + vv.offsetTop + 'px)' : '';
    };
    vv.addEventListener('resize', follow);
    vv.addEventListener('scroll', follow);
  }
  document.addEventListener('focusout', e => {
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    setTimeout(() => { if (!/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) window.scrollTo(window.scrollX, window.scrollY); }, 100);
  });
  if (document.fonts) document.fonts.ready.then(fitTopbar);

  // API key ใกล้หมดอายุ (Worker ส่งมาเฉพาะเจ้าของระบบ · keys.js) → ป้ายแดงบนสุดทุกหน้า กดปิดได้วันละครั้ง
  function drawKeyAlerts(list) {
    let seen = '';
    try { seen = localStorage.getItem('keyAlertSeen') || ''; } catch { /* โหมดส่วนตัว */ }
    const today = new Date().toISOString().slice(0, 10);
    if (!list.length || seen === today || document.getElementById('key-alert')) return;
    const el = document.createElement('div');
    el.id = 'key-alert';
    el.className = 'key-alert';
    el.innerHTML = list.map(k => '🔑 <b>' + esc(k.name) + '</b> (' + esc(k.where) + ') ' + (k.days < 0 ? 'หมดอายุแล้ว' : k.days === 0 ? 'หมดอายุวันนี้' : 'หมดอายุอีก ' + k.days + ' วัน') +
      (k.how ? '<div class="small">' + esc(k.how) + '</div>' : '')).join('<hr>') + '<button type="button" aria-label="ปิด">✕</button>';
    el.querySelector('button').onclick = () => { try { localStorage.setItem('keyAlertSeen', today); } catch { /* ไม่เป็นไร */ } el.remove(); };
    $app.parentNode.insertBefore(el, $app);
  }

  async function start() {
    try {
      await liff.init({ liffId: CFG.LIFF_ID });
      if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
      // ลิงก์จากการ์ดงานในไลน์: liff.line.me/<id>?job=0131 / ?view=review
      // เปิดเว็บครั้งแรกเข้าบอร์ดงานเสมอ (LINE อาจเปิด URL เดิมที่ค้างแท็บเก่าไว้ เช่น #stats)
      // ยกเว้นลิงก์ "เปิดหน้างาน" จากการ์ดในแชท (?job=0131) หรือ ?view=review
      const params = new URLSearchParams(location.search);
      state.fromMenu = params.get('view') === 'new';   // เมนู "แจ้งงานซ่อม" → บันทึกแล้วกลับแชท
      state.openRepair = params.get('repair') === '1';  // ลิงก์ "สรุปการซ่อม" ที่น้องจ๊อบส่งหลังปิดงาน
      const start = params.get('job') ? '#job/' + params.get('job').replace(/\D/g, '')
        : params.get('part') ? '#part/' + params.get('part').replace(/\D/g, '') : params.get('view') === 'parts' ? '#parts'
        : params.get('view') === 'review' ? '#review' : params.get('view') === 'new' ? '#new' : params.get('view') === 'search' ? '#search' : '#board';
      // ลบ ?job= ออกจาก URL หลังใช้แล้ว: รีเฟรช / LINE เปิดหน้าต่างเดิมซ้ำ จะไม่ค้างที่งานเดิม (กดย้อนกลับไปบอร์ดได้ตามปกติ)
      history.replaceState(null, '', location.pathname + start);
      window.addEventListener('hashchange', route);
      // กดแท็บที่อยู่แล้ว = โหลดหน้านั้นใหม่ (hash ไม่เปลี่ยน เลยไม่มี hashchange)
      document.querySelectorAll('.tabs a').forEach(a => a.addEventListener('click', e => {
        if (a.getAttribute('href') === (location.hash || '#board')) { e.preventDefault(); route(); }
      }));
      route();
      core('me').then(m => { setPartsBadge(m.partsBadge || 0); if (m.reviewCount !== undefined) setBadge(m.reviewCount); drawKeyAlerts(m.keyAlerts || []); }).catch(() => {}); // ตัวเลขแท็บถอดอะไหล่ (ของมาแล้ว + รอเกินเดือน) · หลังย้าย: ป้ายคิวตรวจด้วย
      api('me').then(me => {
        state.me = me;
        // เวอร์ชันหน้าเว็บต่อท้ายชื่อ (ดูได้ว่ามือถือโหลดไฟล์ใหม่แล้วหรือยัง)
        const ver = ((document.querySelector('script[src*="app.js"]') || {}).src || '').match(/v=(\d+)/);
        document.getElementById('me').textContent = me.name + (ver ? ' · v' + ver[1] : '');
        fitTopbar(); // บรรทัดชื่อทำให้แถบสูงขึ้น
        document.title = 'ระบบงานช่าง · ' + me.name; // หัวหน้าต่างของ LINE แสดงชื่อนี้ (ถ้ารองรับ)
        setBadge(me.reviewCount);
      }).catch(() => {}); // หน้าหลักแสดงข้อผิดพลาดเองอยู่แล้ว
    } catch (err) {
      showError(err);
    }
  }

  start();
})();
