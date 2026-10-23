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
    already_in_job: 'ข้อความนี้อยู่ในงานแล้ว', not_found_job: 'ไม่พบเลขงานที่จะแนบ', busy: 'ระบบไม่ว่าง ลองใหม่อีกครั้ง',
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
  async function api(action, data, attempt = 1) {
    if (attempt === 1 && CFG.CORE_URL && D1_ACTIONS.indexOf(action) >= 0) {
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
      if (attempt === 1 && READ_ACTIONS.indexOf(action) >= 0) return api(action, data, 2);
      throw new Error('เชื่อมต่อไม่สำเร็จ (เน็ตหลุดหรือระบบตอบช้า) ลองใหม่อีกครั้ง');
    } finally {
      clearTimeout(timer);
    }
    if (out.ms) console.log(action, out.ms + ' ms');
    if (out.error === 'login_expired' || out.error === 'login_required') {
      liff.login({ redirectUri: location.href });
      throw new Error('login');
    }
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
  }

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

  function drawBoard() {
    state.boardView = state.boardView || pref('boardView') || 'list';
    if (state.boardView === 'dash') return drawDashboard();
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
    let html = viewToggle() + asOfLine() + '<div class="toolbar"><input class="search" id="q" type="search" placeholder="ค้นหา เลขงาน ชื่อ ลูกค้า เบอร์" value="' +
      esc(state.query) + '"><div class="chips">' + chip('open', 'เปิดอยู่') + chip('due', '⏰ ถึงวันตาม') +
      chip('quiet', '😶 เงียบ') + chip('closed', 'ปิดแล้ว') +
      (state.filter.indexOf(':') > 0 ? '<button class="chip on" data-filter="open">' + esc(state.filter.split(':')[1]) + ' ✕</button>' : '') +
      '</div></div>';

    if (!jobs.length) html += '<div class="center muted">ไม่มีงาน</div>';
    const groups = q || state.filter === 'closed' ? [['', jobs]]
      : b.statuses.map(s => [s, jobs.filter(j => j.status === s)]).filter(g => g[1].length);
    groups.forEach(([title, list]) => {
      html += '<section class="group">' + (title ? '<div class="band ' + ph(title) + '">' + esc(title) +
        '<span class="n">' + list.length + ' งาน</span></div>' : '');
      list.forEach(j => { html += jobCardHtml(j, b.silentDays); });
      html += '</section>';
    });
    $app.innerHTML = html;
    const input = document.getElementById('q');
    input.oninput = () => {
      state.query = input.value;
      const pos = input.selectionStart;
      drawBoard();
      const again = document.getElementById('q');
      again.focus();
      again.setSelectionRange(pos, pos);
    };
    $app.querySelectorAll('[data-filter]').forEach(btn => btn.onclick = () => {
      state.filter = btn.dataset.filter;
      state.query = '';
      drawBoard();
    });
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
    return '<div class="view-toggle"><div class="segs">' + seg('list', 'รายการ') + seg('dash', 'ภาพรวม') + '</div>' +
      '<a class="btn primary new-job-btn" href="#new">＋ เปิดงาน</a></div><div style="height:10px"></div>';
  }
  function bindViewToggle() {
    $app.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
      state.boardView = b.dataset.view;
      pref('boardView', state.boardView);
      drawBoard();
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

    html += '<div class="stepper" id="stepper">';
    FLOW.forEach((s, i) => {
      const cls = off ? '' : i < idx ? 'past' : i === idx ? 'current' : '';
      html += '<button class="step ' + cls + '" data-status="' + esc(s) + '"><span class="dot">' + (i < idx && !off ? '✓' : i + 1) +
        '</span><span class="lbl">' + esc(shortStatus(s)) + '</span></button>';
    });
    html += '</div>';
    html += '<div class="actions"><button class="btn" id="follow">⏰ ตั้งวันตาม</button>' +
      (j.status !== 'ยกเลิก' ? '<button class="btn danger" id="cancel">ยกเลิกงาน</button>' : '') + '</div>';
    html += '<div class="note-box"><textarea id="note" placeholder="บันทึกโน้ตลงไทม์ไลน์ เช่น โทรแล้วลูกค้าไม่รับ"></textarea>' +
      '<button class="btn primary" id="save-note">บันทึก</button></div>';

    html += '<h3>ไทม์ไลน์</h3><p class="muted small">ข้อความหรือรูปที่ไม่ใช่ของงานนี้ ติ๊กแล้วย้ายไปงานที่ถูก หรือเอาออกได้</p><ul class="timeline">';
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

    const cur = $app.querySelector('.step.current');
    if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest' });
    $app.querySelectorAll('.step').forEach(btn => btn.onclick = () => statusSheet(data, btn.dataset.status));
    document.getElementById('follow').onclick = () => followSheet(data);
    const cancel = document.getElementById('cancel');
    if (cancel) cancel.onclick = () => statusSheet(data, 'ยกเลิก');
    document.getElementById('rename').onclick = () => renameSheet(data);
    document.getElementById('save-note').onclick = async e => {
      const note = document.getElementById('note').value.trim();
      if (!note) return;
      busy(e.target);
      await save(data.job.no, { note }, 'บันทึกโน้ตแล้ว');
    };
    loadThumbs();
  }

  function eventHtml(ev) {
    const kindClass = ev.kind === 'เปลี่ยนสถานะ' ? 'k-status' : ev.kind === 'เปิดงาน' ? 'k-open' : ev.kind === 'สรุปการแก้ไข' ? 'k-fix' : '';
    let body = '';
    if (ev.msg) {
      body += '<div class="what">' + esc(ev.msg.sender) + '</div>';
      if (ev.msg.type === 'text') body += '<div class="text">' + esc(ev.msg.text) + '</div>';
    } else {
      body += '<div class="what">' + esc(ev.kind) + ' <span class="muted small">โดย ' + esc(ev.by) + '</span></div>';
      if (ev.detail) body += '<div class="text">' + esc(ev.detail) + '</div>';
    }
    if (ev.media) {
      if (ev.media.type === 'image') {
        body += ev.media.thumb
          ? '<div class="thumb-ph" data-thumb="' + esc(ev.msgId) + '">กำลังโหลดรูป…</div>'
          : '<div class="thumb-ph">🖼️ รูป (ยังไม่มีรูปย่อ)</div>';
      } else {
        body += '<div class="thumb-ph">' + (ev.media.type === 'video' ? '🎬 คลิป' : '📎 ไฟล์') + '</div>';
      }
      if (ev.media.path) body += '<div class="path">ไฟล์เต็ม: ' + esc(ev.media.path) + '</div>';
      else body += '<div class="path">' + esc(ev.media.status) + '</div>';
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
      toast(okMsg + ' ✅');
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
      '<div class="text">' + esc(it.text) + '</div>' + badge + (it.reason && !done ? '<div class="muted small">' + esc(it.reason) + '</div>' : '') + '</div>';
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
      else if (btn.dataset.act === 'new') newSheet([it], data.statuses);
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
    const on = state.selected.has(it.row);
    return '<div class="rv' + (on ? ' picked' : '') + '"><label class="pick"><input type="checkbox" data-pick="' + it.row + '"' +
      (on ? ' checked' : '') + '><span class="muted small">' + esc(fmtDateTime(it.time)) + ' · ' + esc(it.sender) + '</span></label>' +
      '<div class="text">' + esc(it.text) + '</div><div class="ai">' + ai + '</div><div class="actions">' +
      '<button class="btn' + (it.action === 'งานใหม่' ? ' primary' : '') + '" data-act="new" data-i="' + i + '">＋ งานใหม่</button>' +
      '<button class="btn' + (it.action === 'อัปเดตงานเดิม' ? ' primary' : '') + '" data-act="attach" data-i="' + i + '">📎 แนบงานเดิม</button>' +
      '<button class="btn" data-act="notjob" data-i="' + i + '">ไม่เกี่ยว</button></div></div>';
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
    bar.innerHTML = '<div class="bulk-row"><b>เลือก ' + items.length + ' ข้อ</b><button class="icon-btn" id="bk-clear">ล้าง</button></div>' +
      '<div class="bulk-row actions">' +
      '<button class="btn primary" id="bk-accept">✓ ทำตาม AI' + (unsure ? ' (ข้าม ' + unsure + ' ข้อไม่แน่ใจ)' : '') + '</button>' +
      '<button class="btn" id="bk-new">＋ รวมเป็นงานใหม่ 1 งาน</button>' +
      '<button class="btn" id="bk-attach">📎 แนบเข้างาน…</button>' +
      '<button class="btn" id="bk-notjob">ไม่เกี่ยว</button></div>';
    bar.querySelector('#bk-clear').onclick = () => { state.selected.clear(); if (state.reviewMode === 'chat') drawChat(); else drawReview(); };
    bar.querySelector('#bk-accept').onclick = e => { busy(e.target); decideMany({ decision: 'accept' }); };
    bar.querySelector('#bk-notjob').onclick = e => { busy(e.target); decideMany({ decision: 'notjob' }); };
    const statuses = (state.reviewMode === 'chat' ? state.chat : state.review).statuses;
    bar.querySelector('#bk-new').onclick = () => newSheet(items, statuses);
    bar.querySelector('#bk-attach').onclick = () => attachSheet(items, statuses);
  }

  async function decideMany(choice) {
    const items = selectedItems().map(it => ({ row: it.row, msgId: it.msgId }));
    try {
      const out = await api('decideMany', Object.assign({ items }, choice));
      closeSheet();
      toast('ทำแล้ว ' + out.done + ' ข้อ' + (out.skipped ? ' · ข้าม ' + out.skipped + ' ข้อ' : '') + (out.job ? ' · ' + out.job : '') + ' ✅');
      renderReview();
    } catch (err) {
      if (err.message !== 'login') toast('⚠️ ' + err.message);
      unbusy();
    }
  }

  // noClose = ย้ายข้อความในหน้างานตั้งเป็นปิดไม่ได้ (ปิดจากหน้างานต้องมีสรุป) · คิวตรวจปิดได้ ไม่บังคับสรุป
  const statusOptions = (statuses, selected, withKeep, noClose) => (statuses = statuses.filter(s => !noClose || s !== 'ปิด'),
    (withKeep ? '<option value="">ไม่เปลี่ยนสถานะ</option>' : '') +
    statuses.map(s => '<option' + (s === selected ? ' selected' : '') + '>' + esc(s) + '</option>').join(''));
  const reviewNoteField = '<label class="field">โน้ต (ไม่บังคับ) เช่น แก้อะไรไป / ลูกค้ารับเครื่องแล้ว<textarea id="f-note" rows="2" maxlength="1000"></textarea></label>';

  function newSheet(items, statuses) {
    const first = items[0];
    const many = items.length > 1;
    sheet('<h2>' + (many ? 'รวม ' + items.length + ' ข้อเป็นงานใหม่ 1 งาน' : 'เปิดงานใหม่') + '</h2>' +
      '<label class="field">ชื่องาน<input id="f-title" maxlength="120" value="' + esc(first.title || '') +
      '"></label><label class="field">สถานะ<select id="f-status">' + statusOptions(statuses, first.status || 'รับแจ้ง') +
      '</select></label>' + reviewNoteField + '<div class="actions"><button class="btn primary" id="f-ok">เปิดงาน</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      el.querySelector('#f-ok').onclick = e => {
        busy(e.target);
        const choice = { decision: 'new', title: el.querySelector('#f-title').value.trim(), status: el.querySelector('#f-status').value, note: el.querySelector('#f-note').value.trim() };
        if (many) decideMany(choice); else decide(first, choice, null);
      };
    });
  }

  function attachSheet(items, statuses) {
    const opts = [];
    items.forEach(it => {
      if (it.job && !opts.some(o => o.no === it.job)) opts.push({ no: it.job, label: it.jobLabel });
      it.candidates.forEach(c => { if (!opts.some(o => o.no === c.no)) opts.push(c); });
    });
    const many = items.length > 1;
    sheet('<h2>' + (many ? 'แนบ ' + items.length + ' ข้อเข้างานเดียวกัน' : 'แนบเข้างานเดิม') + '</h2><label class="field">เลขงาน' +
      (opts.length ? '<select id="f-pick">' + opts.map(o => '<option value="' + esc(o.no) + '">' + esc(o.label) + '</option>').join('') +
        '<option value="">พิมพ์เลขงานเอง…</option></select>' : '') +
      '<input id="f-job" inputmode="numeric" placeholder="เช่น 131"' + (opts.length ? ' hidden' : '') + '></label>' +
      '<label class="field">สถานะ<select id="f-status">' + statusOptions(statuses, many ? '' : items[0].status, true) + '</select></label>' + reviewNoteField +
      '<div class="actions"><button class="btn primary" id="f-ok">แนบ</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      const pick = el.querySelector('#f-pick');
      const input = el.querySelector('#f-job');
      if (pick) pick.onchange = () => { input.hidden = !!pick.value; };
      el.querySelector('#f-ok').onclick = e => {
        const job = (pick && pick.value) || input.value.trim();
        if (!job) { toast('ใส่เลขงานก่อน'); return; }
        busy(e.target);
        const choice = { decision: 'attach', job, status: el.querySelector('#f-status').value, note: el.querySelector('#f-note').value.trim() };
        if (many) decideMany(choice); else decide(items[0], choice, null);
      };
    });
  }

  async function decide(it, choice, okMsg) {
    try {
      const out = await api('decide', Object.assign({ row: it.row, msgId: it.msgId }, choice));
      closeSheet();
      toast(okMsg || (out.verdict + ' ✅'));
      renderReview();
    } catch (err) {
      if (err.message !== 'login') toast('⚠️ ' + err.message);
      unbusy();
    }
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
    bad_phone: 'เบอร์โทรต้องมีอย่างน้อย 9 หลัก', no_symptom: 'ใส่อาการก่อน', storage_off: 'ที่เก็บรูปยังไม่เปิด แจ้งผู้ดูแล',
    bad_type: 'รองรับเฉพาะรูปและคลิป', too_big: 'ไฟล์ใหญ่เกิน 60 MB (ตัดคลิปให้สั้นลง)', bad_image: 'อ่านรูปไม่ได้', ai_failed: 'AI อ่านรูปไม่สำเร็จ ลองใหม่',
    core_failed: 'บันทึกงานในระบบเดิมไม่สำเร็จ ลองใหม่', no_title: 'ข้อมูลไม่พอสำหรับตั้งชื่องาน',
    no_serial: 'ใส่ SN / เลขเครื่อง (ถ่ายรูปป้ายให้ AI อ่าน หรือเลือก "ป้ายชำรุด" / "ไม่มีป้าย")'
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
      throw new Error('เชื่อมต่อไม่สำเร็จ (เน็ตหลุดหรือระบบตอบช้า) ลองใหม่อีกครั้ง');
    } finally { clearTimeout(timer); }
    if (out.ms) console.log('core', action, out.ms + ' ms');
    if (out.error === 'login_expired' || out.error === 'login_required') { liff.login({ redirectUri: location.href }); throw new Error('login'); }
    if (out.error) throw new Error(CORE_ERRORS[out.error] || ERRORS[out.error] || out.error);
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

  async function uploadFile(file) {
    const blob = await shrink(file);
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
      'placeholder="ชื่อ เบอร์ รุ่น SN จังหวัด หรือคำในแชท" value="' + esc(q) + '"><button class="btn primary" id="sgo">ค้นหา</button></div>' +
      '<label class="btn" id="simg-l">📷 ค้นด้วยรูป (ป้ายเครื่อง/SN/นามบัตร)<input type="file" id="simg" accept="image/*" hidden></label></div><div id="sres">' +
      (state.searchHtml || '<div class="center muted">ค้นประวัติจากทุกงานและแชทเก่า</div>') + '</div>';
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
    if (!out.jobs.length && !out.loose.length) html += '<div class="center muted">ไม่พบ "' + esc(q) + '"</div>';
    if (out.jobs.length) html += '<div class="muted small">งานที่เกี่ยวข้อง ' + out.jobs.length + ' งาน</div>';
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
    $app.innerHTML = '<form id="nf" class="intake" autocomplete="off">' +
      '<div class="field"><span class="lbl">รูป / คลิป <b class="req">*</b></span><div class="files" id="files"></div>' +
      '<label class="btn"><input type="file" id="fpick" accept="image/*,video/*" multiple hidden>＋ ถ่าย / เลือกรูป คลิป</label></div>' +
      '<label class="field"><span class="lbl">อาการ / สิ่งที่ลูกค้าแจ้ง <b class="req">*</b></span><textarea name="symptom" rows="3" required>' + esc(v.symptom || '') + '</textarea></label>' +
      '<label class="field"><span class="lbl">เบอร์ลูกค้า <b class="req">*</b></span><input name="phone" type="tel" inputmode="tel" value="' + esc(v.phone || '') + '" required></label>' +
      '<div id="dup"></div>' +
      '<label class="field"><span class="lbl">ชื่อลูกค้า / ร้าน</span><input name="customer" value="' + esc(v.customer || '') + '"></label>' +
      '<label class="field"><span class="lbl">สินค้า / รุ่น</span><input name="product" list="plist" value="' + esc(v.product || '') + '"><datalist id="plist">' +
        PRODUCT_HINTS.map(p => '<option value="' + esc(p) + '">').join('') + '</datalist></label>' +
      '<div class="field"><span class="lbl">SN / เลขเครื่อง <b class="req">*</b></span>' +
        '<input name="serial" value="' + esc(v.serial || '') + '">' +
        '<label class="btn"><input type="file" id="plate" accept="image/*" capture="environment" hidden>📷 ถ่ายป้ายเครื่อง / เนมเพลท ให้ AI อ่าน SN</label>' +
        '<div class="muted small" id="plate-out"></div>' +
        '<select name="plateState">' + [['', 'ป้ายอ่านได้ครบ'], ['damaged', 'ป้ายชำรุด / เลขเลือน ขาดบางตัว'], ['none', 'เครื่องไม่มีป้าย / ป้ายหาย']]
          .map(o => '<option value="' + o[0] + '"' + (o[0] === (v.plateState || '') ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
      '<label class="field"><span class="lbl">ที่อยู่</span><textarea name="address" rows="2">' + esc(v.address || '') + '</textarea></label>' +
      '<label class="field"><span class="lbl">จังหวัด</span><select name="province">' + opt(PROVINCES, v.province) + '</select></label>' +
      '<div class="field"><span class="lbl">ตำแหน่ง</span><div class="search-row"><button type="button" class="btn" id="geo">📍 ตำแหน่งปัจจุบัน</button>' +
        '<input name="mapUrl" placeholder="หรือวางลิงก์ Google Maps" value="' + esc(v.mapUrl || '') + '"></div><div class="muted small" id="geo-out">' +
        (v.lat ? 'ปักหมุดแล้ว ' + v.lat.toFixed(5) + ', ' + v.lng.toFixed(5) : '') + '</div></div>' +
      '<label class="check"><input type="checkbox" name="atShop"' + (v.atShop ? ' checked' : '') + '> เครื่องอยู่ที่ศูนย์ (พิมพ์ป้าย QR)</label>' +
      '<label class="check"><input type="checkbox" name="sendCard"' + (v.sendCard === false ? '' : ' checked') + '> ส่งการ์ดงานเข้ากลุ่มช่าง</label>' +
      '<div id="attach-note"></div><button class="btn primary wide" id="nsubmit">เปิดงาน</button></form>';
    const form = document.getElementById('nf');
    const keep = () => { const fd = new FormData(form); ['symptom', 'phone', 'customer', 'product', 'serial', 'address', 'province', 'mapUrl'].forEach(k => { intake[k] = fd.get(k); });
      intake.atShop = form.atShop.checked; intake.sendCard = form.sendCard.checked; intake.plateState = form.plateState.value; };
    form.oninput = keep;
    form.plateState.onchange = () => { keep(); drawPlateState(); };
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
      }, () => { out.textContent = 'หาตำแหน่งไม่ได้ (ต้องอนุญาตตำแหน่งให้ LINE)'; }, { enableHighAccuracy: true, timeout: 15000 });
    };
    form.phone.onblur = checkPhone;
    form.onsubmit = submitJob;
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
      .then(drawFiles);
  }

  function drawFiles() {
    const el = document.getElementById('files');
    if (!el) return;
    el.innerHTML = intake.files.map((f, i) => '<div class="file">' + (f.type === 'image' ? '<img src="' + f.url + '" alt="">' : '<div class="vid">🎬</div>') +
      (f.state ? '<span class="fstate' + (f.error ? ' bad' : '') + '">' + esc(f.state) + '</span>' : '') +
      '<button type="button" class="fdel" data-i="' + i + '" aria-label="ลบ">✕</button></div>').join('');
    el.querySelectorAll('.fdel').forEach(b => b.onclick = () => { intake.files.splice(Number(b.dataset.i), 1); drawFiles(); });
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
    if (String(form.phone.value).replace(/\D/g, '').length < 9) return toast(CORE_ERRORS.bad_phone);
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
      const done = { no: out.no, url: out.url, card: out.card, print: out.print, attached: !!intake.attachTo,
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
    $app.innerHTML = '<div class="panel-box created"><div class="big-no">' + esc(d.no) + '</div><div>' + (d.attached ? 'เพิ่มข้อมูลเข้างานแล้ว' : 'เปิดงานแล้ว') +
      (d.card ? ' · ส่งการ์ดเข้ากลุ่มแล้ว' : '') + (d.print ? ' · เข้าคิวพิมพ์ป้าย' : '') + '</div>' +
      '<div id="label-box"></div><div class="actions"><a class="btn primary" href="#job/' + noDigits(d.no) + '">เปิดหน้างาน</a>' +
      '<button class="btn" id="dl-label">ดาวน์โหลดป้าย QR</button><a class="btn" href="#new">เปิดงานอื่น</a></div>' +
      '<div class="muted small">ดาวน์โหลดป้ายแล้วเปิดในแอป NIIMBOT เพื่อพิมพ์ (ฉลาก 50×30 มม.) · ถ้ากดดาวน์โหลดไม่ได้ ให้กดค้างที่รูปแล้วบันทึก</div></div>';
    if (typeof qrcode !== 'function') return;
    const c = labelCanvas(d.label, d.url);
    const img = new Image(); img.src = c.toDataURL('image/png'); img.className = 'label-img'; img.alt = 'ป้าย ' + d.no;
    document.getElementById('label-box').appendChild(img);
    document.getElementById('dl-label').onclick = () => { const a = document.createElement('a'); a.href = img.src; a.download = 'label-' + noDigits(d.no) + '.png'; a.click(); };
  }

  // ---------- เส้นทาง ----------
  async function route() {
    closeSheet();
    if (location.hash !== '#review') { const bar = document.getElementById('bulkbar'); if (bar) bar.remove(); }
    { const mv = document.getElementById('movebar'); if (mv) mv.remove(); }
    const hash = location.hash || '#board';
    try {
      const m = hash.match(/^#job\/(\d+)/);
      if (m) await renderJob(m[1]);
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

  async function start() {
    try {
      await liff.init({ liffId: CFG.LIFF_ID });
      if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
      // ลิงก์จากการ์ดงานในไลน์: liff.line.me/<id>?job=0131 / ?view=review
      // เปิดเว็บครั้งแรกเข้าบอร์ดงานเสมอ (LINE อาจเปิด URL เดิมที่ค้างแท็บเก่าไว้ เช่น #stats)
      // ยกเว้นลิงก์ "เปิดหน้างาน" จากการ์ดในแชท (?job=0131) หรือ ?view=review
      const params = new URLSearchParams(location.search);
      const start = params.get('job') ? '#job/' + params.get('job').replace(/\D/g, '')
        : params.get('view') === 'review' ? '#review' : params.get('view') === 'new' ? '#new' : params.get('view') === 'search' ? '#search' : '#board';
      // ลบ ?job= ออกจาก URL หลังใช้แล้ว: รีเฟรช / LINE เปิดหน้าต่างเดิมซ้ำ จะไม่ค้างที่งานเดิม (กดย้อนกลับไปบอร์ดได้ตามปกติ)
      history.replaceState(null, '', location.pathname + start);
      window.addEventListener('hashchange', route);
      // กดแท็บที่อยู่แล้ว = โหลดหน้านั้นใหม่ (hash ไม่เปลี่ยน เลยไม่มี hashchange)
      document.querySelectorAll('.tabs a').forEach(a => a.addEventListener('click', e => {
        if (a.getAttribute('href') === (location.hash || '#board')) { e.preventDefault(); route(); }
      }));
      route();
      api('me').then(me => {
        state.me = me;
        document.getElementById('me').textContent = me.name;
        setBadge(me.reviewCount);
      }).catch(() => {}); // หน้าหลักแสดงข้อผิดพลาดเองอยู่แล้ว
    } catch (err) {
      showError(err);
    }
  }

  start();
})();
