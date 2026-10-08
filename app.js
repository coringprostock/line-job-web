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
    } else {
      jobs = jobs.filter(j => state.filter === 'open' ? !j.closed : state.filter === 'due' ? j.due
        : state.filter === 'quiet' ? !j.closed && !j.due && j.quietDays >= b.silentDays : j.closed);
    }
    const chip = (key, label) => '<button class="chip' + (state.filter === key && !q ? ' on' : '') + '" data-filter="' + key + '">' +
      label + ' ' + counts[key] + '</button>';
    let html = '<div class="toolbar"><input class="search" id="q" type="search" placeholder="ค้นหา เลขงาน ชื่อ ลูกค้า เบอร์" value="' +
      esc(state.query) + '"><div class="chips">' + chip('open', 'เปิดอยู่') + chip('due', '⏰ ถึงวันตาม') +
      chip('quiet', '😶 เงียบ') + chip('closed', 'ปิดแล้ว') + '</div></div>';

    if (!jobs.length) html += '<div class="center muted">ไม่มีงาน</div>';
    const groups = q || state.filter === 'closed' ? [['', jobs]]
      : b.statuses.map(s => [s, jobs.filter(j => j.status === s)]).filter(g => g[1].length);
    groups.forEach(([title, list]) => {
      html += '<section class="group">' + (title ? '<h3>' + esc(title) + ' (' + list.length + ')</h3>' : '');
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
  }

  function jobCardHtml(j, silentDays) {
    const meta = [];
    meta.push('<span class="pill' + (j.closed ? ' closed' : '') + '">' + esc(shortStatus(j.status)) + '</span>');
    if (j.customer) meta.push(esc(j.customer));
    if (j.due) meta.push('<span class="flag-due">⏰ ตาม ' + esc(fmtKey(j.follow)) + '</span>');
    else if (j.follow && !j.closed) meta.push('ตาม ' + esc(fmtKey(j.follow)));
    if (!j.closed && j.quietDays >= silentDays) meta.push('<span class="flag-quiet">😶 เงียบ ' + j.quietDays + ' วัน</span>');
    meta.push('ล่าสุด ' + esc(fmtDate(j.last)));
    return '<a class="card" href="#job/' + noDigits(j.no) + '"><div class="top"><span class="no">' + esc(j.no) +
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

  async function renderReview() {
    setTab('review');
    $app.innerHTML = '<div class="center muted">กำลังโหลดคิวตรวจ…</div>';
    const data = await api('review');
    state.review = data;
    state.selected = new Set();
    setBadge(data.items.length);
    drawReview();
  }

  function drawReview() {
    const data = state.review;
    if (!data.items.length) {
      $app.innerHTML = '<div class="center"><p>✅ ไม่มีข้อที่ต้องตรวจ</p><p class="muted small">ข้อเสนอของ AI ใน 3 วันล่าสุดตัดสินครบแล้ว</p></div>';
      drawBulkBar();
      return;
    }
    let html = '<p class="muted small">ข้อเสนอของ AI ที่ยังไม่มีคนยืนยัน ' + data.items.length +
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
    $app.querySelectorAll('[data-act]').forEach(btn => btn.onclick = () => {
      const it = data.items[Number(btn.dataset.i)];
      if (btn.dataset.act === 'notjob') { busy(btn); decide(it, { decision: 'notjob' }, 'บันทึกว่าไม่เกี่ยวแล้ว'); }
      else if (btn.dataset.act === 'new') newSheet([it], data.statuses);
      else attachSheet([it], data.statuses);
    });
    $app.querySelectorAll('[data-pick]').forEach(box => box.onchange = () => {
      const row = Number(box.dataset.pick);
      if (box.checked) state.selected.add(row); else state.selected.delete(row);
      box.closest('.rv').classList.toggle('picked', box.checked);
      drawBulkBar();
    });
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
    return state.review ? state.review.items.filter(it => state.selected.has(it.row)) : [];
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
    bar.querySelector('#bk-clear').onclick = () => { state.selected.clear(); drawReview(); };
    bar.querySelector('#bk-accept').onclick = e => { busy(e.target); decideMany({ decision: 'accept' }); };
    bar.querySelector('#bk-notjob').onclick = e => { busy(e.target); decideMany({ decision: 'notjob' }); };
    bar.querySelector('#bk-new').onclick = () => newSheet(items, state.review.statuses);
    bar.querySelector('#bk-attach').onclick = () => attachSheet(items, state.review.statuses);
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

  // ---------- เส้นทาง ----------
  async function route() {
    closeSheet();
    if (location.hash !== '#review') { const bar = document.getElementById('bulkbar'); if (bar) bar.remove(); }
    const hash = location.hash || '#board';
    try {
      const m = hash.match(/^#job\/(\d+)/);
      if (m) await renderJob(m[1]);
      else if (hash === '#review') await renderReview();
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
      const params = new URLSearchParams(location.search);
      if (params.get('job') && !location.hash) location.hash = '#job/' + params.get('job').replace(/\D/g, '');
      if (params.get('view') === 'review' && !location.hash) location.hash = '#review';
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
