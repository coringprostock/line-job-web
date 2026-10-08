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
    nothing_selected: 'ยังไม่ได้เลือกข้อ', server_error: 'เกิดข้อผิดพลาดที่ระบบ (บันทึกในชีต Errors แล้ว)'
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
  async function api(action, data, attempt = 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    let out;
    try {
      const res = await fetch(CFG.API_URL, {
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
    return out;
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

  function setTab(tab) {
    document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  }

  // ---------- บอร์ดงาน ----------
  async function renderBoard() {
    setTab('board');
    if (state.board) drawBoard(); // แสดงของเดิมทันที แล้วโหลดใหม่ตามหลัง
    else $app.innerHTML = '<div class="center muted">กำลังโหลดงาน…</div>';
    const fresh = await api('board');
    state.board = fresh;
    setBadge(fresh.reviewCount);
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
    let html = viewToggle() + '<div class="toolbar"><input class="search" id="q" type="search" placeholder="ค้นหา เลขงาน ชื่อ ลูกค้า เบอร์" value="' +
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
  }

  function viewToggle() {
    const seg = (v, label) => '<button class="seg' + (state.boardView === v ? ' on' : '') + '" data-view="' + v + '">' + label + '</button>';
    return '<div class="view-toggle"><div class="segs">' + seg('list', 'รายการ') + seg('dash', 'ภาพรวม') + '</div></div><div style="height:10px"></div>';
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
    $app.innerHTML = '<div class="center muted">กำลังโหลดงาน…</div>';
    drawJob(await api('job', { no }));
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

    html += '<h3>ไทม์ไลน์</h3><ul class="timeline">';
    data.events.forEach(ev => { html += eventHtml(ev); });
    html += '</ul>';
    $app.innerHTML = html;

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
    const kindClass = ev.kind === 'เปลี่ยนสถานะ' ? 'k-status' : ev.kind === 'เปิดงาน' ? 'k-open' : '';
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
    return '<li class="' + kindClass + '"><div class="when">' + esc(fmtDateTime(when)) +
      (ev.job && ev.job !== (state.currentJob || ev.job) ? ' · ' + esc(ev.job) : '') + '</div>' + body + '</li>';
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
    try {
      const data = await api('update', Object.assign({ no }, changes));
      closeSheet();
      drawJob(data);
      toast(okMsg);
    } catch (err) {
      if (err.message !== 'login') toast('⚠️ ' + err.message);
      unbusy();
    }
  }

  function statusSheet(data, status) {
    const waiting = data.waitingCustomer.indexOf(status) >= 0;
    const html = '<h2>เปลี่ยนเป็น “' + esc(status) + '”</h2>' +
      '<p class="muted small">' + esc(data.job.no) + ' ' + esc(data.job.title) + ' · ตอนนี้: ' + esc(data.job.status) + '</p>' +
      (status === 'ปิด' || status === 'ยกเลิก' ? '' :
        '<label class="field">วันที่ต้องตามต่อ' + (waiting ? ' (รอลูกค้า ต้องมีวันตาม)' : ' (ไม่บังคับ)') +
        '<input type="date" id="f-date" min="' + todayKey() + '" value="' + (waiting ? nextBusinessKey() : '') + '"></label>') +
      '<label class="field">โน้ต (ไม่บังคับ)<textarea id="f-note" rows="2"></textarea></label>' +
      '<div class="actions"><button class="btn primary" id="f-ok">บันทึก</button><button class="btn" data-close>ยกเลิก</button></div>';
    sheet(html, el => {
      el.querySelector('#f-ok').onclick = async e => {
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
    state.reviewMode = state.reviewMode || 'queue';
    state.selected = new Set();
    $app.innerHTML = reviewHeader() + '<div class="center muted">กำลังโหลด…</div>';
    bindReviewHeader();
    if (state.reviewMode === 'chat') {
      state.chatDate = state.chatDate || todayKey();
      state.chat = await api('chat', { date: state.chatDate });
      drawChat();
    } else {
      state.review = await api('review');
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
    if (it.inJob) badge = '<span class="tag tag-job">📂 ' + esc(it.inJobLabel) + '</span>';
    else if (it.human) badge = '<span class="tag">ตัดสินแล้ว: ' + esc(it.human) + '</span>';
    else if (/กติกา: ข้าม/.test(it.source)) badge = '<span class="tag tag-skip">ข้าม (คำตอบรับ)</span>';
    else badge = '<span class="tag tag-ai">AI: ' + esc(it.action) + (it.jobLabel ? ' → ' + esc(it.jobLabel) : '') + ' · ' + it.conf + '%</span>';
    const on = state.selected.has(it.row);
    return '<div class="rv chat' + (done ? ' done' : '') + (on ? ' picked' : '') + '"><label class="pick">' +
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
      $app.innerHTML = reviewHeader() + '<div class="center"><p>✅ ไม่มีข้อที่ต้องตรวจ</p><p class="muted small">ข้อเสนอของ AI ใน 3 วันล่าสุดตัดสินครบแล้ว · ' +
        'ถ้าคิดว่า AI ข้ามงานไป ดูในโหมด “ไล่ตามแชท”</p></div>';
      bindReviewHeader();
      drawBulkBar();
      return;
    }
    let html = reviewHeader() + '<p class="muted small">ข้อเสนอของ AI ที่ยังไม่มีคนยืนยัน ' + data.items.length +
      ' ข้อ (3 วันล่าสุด) · ติ๊กหลายข้อแล้วกดแถบด้านล่างได้</p>';
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

  const statusOptions = (statuses, selected, withKeep) =>
    (withKeep ? '<option value="">ไม่เปลี่ยนสถานะ</option>' : '') +
    statuses.map(s => '<option' + (s === selected ? ' selected' : '') + '>' + esc(s) + '</option>').join('');

  function newSheet(items, statuses) {
    const first = items[0];
    const many = items.length > 1;
    sheet('<h2>' + (many ? 'รวม ' + items.length + ' ข้อเป็นงานใหม่ 1 งาน' : 'เปิดงานใหม่') + '</h2>' +
      '<label class="field">ชื่องาน<input id="f-title" maxlength="120" value="' + esc(first.title || '') +
      '"></label><label class="field">สถานะ<select id="f-status">' + statusOptions(statuses, first.status || 'รับแจ้ง') +
      '</select></label><div class="actions"><button class="btn primary" id="f-ok">เปิดงาน</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      el.querySelector('#f-ok').onclick = e => {
        busy(e.target);
        const choice = { decision: 'new', title: el.querySelector('#f-title').value.trim(), status: el.querySelector('#f-status').value };
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
      '<label class="field">สถานะ<select id="f-status">' + statusOptions(statuses, many ? '' : items[0].status, true) + '</select></label>' +
      '<div class="actions"><button class="btn primary" id="f-ok">แนบ</button><button class="btn" data-close>ยกเลิก</button></div>', el => {
      const pick = el.querySelector('#f-pick');
      const input = el.querySelector('#f-job');
      if (pick) pick.onchange = () => { input.hidden = !!pick.value; };
      el.querySelector('#f-ok').onclick = e => {
        const job = (pick && pick.value) || input.value.trim();
        if (!job) { toast('ใส่เลขงานก่อน'); return; }
        busy(e.target);
        const choice = { decision: 'attach', job, status: el.querySelector('#f-status').value };
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
    state.statsRange = state.statsRange || pref('statsRange') || '30';
    const [from, to] = rangeOf(state.statsRange);
    $app.innerHTML = statsHeader(from, to) + '<div class="center muted">กำลังคำนวณสถิติ…</div>';
    bindStatsHeader();
    const st = await api('stats', { from, to });
    drawStats(st);
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

  // ---------- เส้นทาง ----------
  async function route() {
    closeSheet();
    if (location.hash !== '#review') { const bar = document.getElementById('bulkbar'); if (bar) bar.remove(); }
    const hash = location.hash || '#board';
    try {
      const m = hash.match(/^#job\/(\d+)/);
      if (m) await renderJob(m[1]);
      else if (hash === '#review') await renderReview();
      else if (hash === '#stats') await renderStats();
      else await renderBoard();
      window.scrollTo(0, 0);
    } catch (err) {
      showError(err);
    }
  }

  async function start() {
    try {
      await liff.init({ liffId: CFG.LIFF_ID });
      if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
      // ลิงก์จากการ์ดงานในไลน์: liff.line.me/<id>?job=0131 / ?view=review
      // เปิดเว็บครั้งแรกเข้าบอร์ดงานเสมอ (LINE อาจเปิด URL เดิมที่ค้างแท็บเก่าไว้ เช่น #stats)
      // ยกเว้นลิงก์ "เปิดหน้างาน" จากการ์ดในแชท (?job=0131) หรือ ?view=review
      const params = new URLSearchParams(location.search);
      const start = params.get('job') ? '#job/' + params.get('job').replace(/\D/g, '')
        : params.get('view') === 'review' ? '#review' : '#board';
      if (location.hash !== start) history.replaceState(null, '', location.pathname + location.search + start);
      window.addEventListener('hashchange', route);
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
