/* ============================================================
   Padel Tactics — тактическая доска (Telegram Mini App)
   Стиль: Aurora Glass.

   Кадры (frames): доска — это последовательность кадров, каждый со
   своими фишками и рисунками. state.tokens / state.drawings всегда
   ссылаются на текущий кадр (state.frames[state.current]).

   Рисунки:
     pen   : {type,color,width,points:[{x,y}...]}
     arrow : {type,color,width,points:[...]}      (кривая + наконечник)
     zone  : {type,color,from:{x,y},to:{x,y}}      (прямоугольная область)
   ============================================================ */

(() => {
  'use strict';

  // ---------- Telegram ----------
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  function haptic(kind = 'light') {
    try {
      if (!tg || !tg.HapticFeedback) return;
      if (kind === 'select') tg.HapticFeedback.selectionChanged();
      else tg.HapticFeedback.impactOccurred(kind);
    } catch (_) {}
  }

  if (tg) {
    try {
      tg.ready();
      tg.expand();
      tg.setHeaderColor('#080D1A');
      tg.setBackgroundColor('#080D1A');
      if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    } catch (_) {}
  }

  // ---------- DOM ----------
  const canvas = document.getElementById('board');
  const screenCtx = canvas.getContext('2d');
  const courtArea = document.getElementById('court-area');
  const toastEl = document.getElementById('toast');

  // Контекстные действия над выделенным объектом (создаём сразу)
  const objActions = document.createElement('div');
  objActions.className = 'obj-actions';
  objActions.innerHTML =
    '<button class="dup" title="Дублировать"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>' +
    '<button class="del" title="Удалить"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg></button>';
  document.body.appendChild(objActions);

  // ---------- Цель отрисовки ----------
  let gfx = screenCtx;
  let court = { x: 0, y: 0, w: 0, h: 0 };
  let dpr = 1;

  function withTarget(newCtx, newCourt, fn) {
    const prevGfx = gfx, prevCourt = court;
    gfx = newCtx; court = newCourt;
    try { fn(); } finally { gfx = prevGfx; court = prevCourt; }
  }

  // ---------- Состояние ----------
  const COLORS = ['#F4F7FB', '#FBBF24', '#38BDF8', '#FB7185', '#34D399', '#A5B4FC'];
  const WIDTHS = { thin: 2.5, med: 4, thick: 6.5 };
  const HANDLE_HIT = 22;

  // История для отмены/возврата (снимки кадров)
  const undoStack = [], redoStack = [];

  const state = {
    tool: 'move',
    color: '#F4F7FB',
    width: 'med',
    frames: [{ tokens: defaultTokens(), drawings: [] }],
    current: 0,
    tokens: null,     // ссылка на кадр
    drawings: null,   // ссылка на кадр
    selected: null,
  };

  function defaultTokens() {
    // Стартовая позиция — на задней линии. Слева №2, справа №1.
    const back = 0.075, front = 0.925, xl = 0.30, xr = 0.70;
    return [
      { id: 'B2', team: 'b', label: '2', x: xl, y: back },
      { id: 'B1', team: 'b', label: '1', x: xr, y: back },
      { id: 'A2', team: 'a', label: '2', x: xl, y: front },
      { id: 'A1', team: 'a', label: '1', x: xr, y: front },
    ];
  }

  const isPath = (d) => d.type === 'pen' || d.type === 'arrow';

  // ---------- Кадры ----------
  function loadFrame(i) {
    state.current = Math.max(0, Math.min(state.frames.length - 1, i));
    state.tokens = state.frames[state.current].tokens;
    state.drawings = state.frames[state.current].drawings;
    state.selected = null;
    objActions.classList.remove('show');
  }

  function gotoFrame(i) {
    if (i < 0 || i >= state.frames.length || i === state.current) return;
    loadFrame(i);
    render(); updateFrameUI(); haptic('select');
  }

  function addFrame() {
    pushUndo();
    const src = state.frames[state.current];
    state.frames.splice(state.current + 1, 0, {
      tokens: JSON.parse(JSON.stringify(src.tokens)),
      drawings: JSON.parse(JSON.stringify(src.drawings)),
    });
    loadFrame(state.current + 1);
    render(); updateFrameUI(); haptic('medium'); toast('Кадр добавлен (копия)');
  }

  function deleteFrame() {
    if (state.frames.length <= 1) { toast('Остался один кадр'); return; }
    pushUndo();
    state.frames.splice(state.current, 1);
    loadFrame(Math.min(state.current, state.frames.length - 1));
    render(); updateFrameUI(); haptic('rigid'); toast('Кадр удалён');
  }

  function updateFrameUI() {
    frCur.textContent = state.current + 1;
    frTotal.textContent = state.frames.length;
    frPrev.disabled = state.current === 0;
    frNext.disabled = state.current === state.frames.length - 1;
    frDel.disabled = state.frames.length <= 1;
  }

  // ---------- История (отмена / возврат) ----------
  function snapshot() { return { frames: JSON.parse(JSON.stringify(state.frames)), current: state.current }; }
  function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0; }
  function restoreSnap(snap) {
    state.frames = JSON.parse(JSON.stringify(snap.frames));
    loadFrame(Math.min(snap.current, state.frames.length - 1));
    render(); updateFrameUI();
  }
  function undo() {
    if (!undoStack.length) { toast('Нечего отменить'); return; }
    redoStack.push(snapshot());
    restoreSnap(undoStack.pop());
    haptic('light');
  }
  function redo() {
    if (!redoStack.length) { toast('Нечего вернуть'); return; }
    undoStack.push(snapshot());
    restoreSnap(redoStack.pop());
    haptic('light');
  }

  // ---------- Размер / DPI ----------
  function resize() {
    const rect = courtArea.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    screenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    court = fitCourt(rect.width, rect.height, 30);
    render();
  }

  function fitCourt(W, H, pad) {
    const availW = W - pad * 2, availH = H - pad * 2;
    const ratio = 0.5;
    let w, h;
    if (availW / availH > ratio) { h = availH; w = h * ratio; }
    else { w = availW; h = w / ratio; }
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  // ---------- Координаты ----------
  const toPx = (n) => ({ x: court.x + n.x * court.w, y: court.y + n.y * court.h });
  const toNorm = (px, py) => ({ x: (px - court.x) / court.w, y: (py - court.y) / court.h });
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const normPt = (px, py) => { const n = toNorm(px, py); return { x: clamp01(n.x), y: clamp01(n.y) }; };
  const tokenRadius = () => court.w * 0.064;

  // ---------- Примитивы ----------
  function roundRectPath(x, y, w, h, r) {
    gfx.beginPath();
    gfx.moveTo(x + r, y);
    gfx.arcTo(x + w, y, x + w, y + h, r);
    gfx.arcTo(x + w, y + h, x, y + h, r);
    gfx.arcTo(x, y + h, x, y, r);
    gfx.arcTo(x, y, x + w, y, r);
    gfx.closePath();
  }
  const hLine = (x1, x2, y) => { gfx.beginPath(); gfx.moveTo(x1, y); gfx.lineTo(x2, y); gfx.stroke(); };
  const vLine = (x, y1, y2) => { gfx.beginPath(); gfx.moveTo(x, y1); gfx.lineTo(x, y2); gfx.stroke(); };
  const dot = (x, y, r) => { gfx.beginPath(); gfx.arc(x, y, r, 0, Math.PI * 2); gfx.fill(); };

  // ---------- Ограждение: стекло, решётка, балки ----------
  function drawGlassBand(rx, ry, rw, rh) {
    gfx.fillStyle = 'rgba(125,211,252,0.16)';
    gfx.fillRect(rx, ry, rw, rh);
    gfx.strokeStyle = 'rgba(186,230,253,0.5)';
    gfx.lineWidth = 1.2;
    gfx.strokeRect(rx + 0.6, ry + 0.6, rw - 1.2, rh - 1.2);
  }
  function drawMeshBand(rx, ry, rw, rh) {
    gfx.save();
    gfx.beginPath(); gfx.rect(rx, ry, rw, rh);
    gfx.fillStyle = 'rgba(148,163,184,0.09)'; gfx.fill();
    gfx.clip();
    gfx.strokeStyle = 'rgba(148,163,184,0.45)'; gfx.lineWidth = 1;
    const s = 6, span = rw + rh;
    for (let i = -rh; i < span; i += s) {
      gfx.beginPath(); gfx.moveTo(rx + i, ry + rh); gfx.lineTo(rx + i + rh, ry); gfx.stroke();
      gfx.beginPath(); gfx.moveTo(rx + i, ry); gfx.lineTo(rx + i + rh, ry + rh); gfx.stroke();
    }
    gfx.restore();
  }
  function drawBeam(cx, cy, wt) {
    const bw = wt * 1.5, bh = wt * 2.3, r = Math.min(3, bw / 2);
    const x = cx - bw / 2, y = cy - bh / 2;
    gfx.save();
    gfx.shadowColor = 'rgba(0,0,0,0.5)'; gfx.shadowBlur = 4; gfx.shadowOffsetY = 1;
    roundRectPath(x, y, bw, bh, r);
    const g = gfx.createLinearGradient(x, 0, x + bw, 0);
    g.addColorStop(0, '#8b98a8'); g.addColorStop(0.5, '#e6ecf3'); g.addColorStop(1, '#7c8a9b');
    gfx.fillStyle = g; gfx.fill();
    gfx.restore();
    roundRectPath(x, y, bw, bh, r);
    gfx.lineWidth = 1; gfx.strokeStyle = 'rgba(15,23,42,0.55)'; gfx.stroke();
  }
  function drawEnclosure(x, y, w, h) {
    const wt = Math.max(7, w * 0.028);
    const corner = h * 0.14;
    const netY = y + h / 2;
    drawGlassBand(x - wt, y - wt, w + 2 * wt, wt);
    drawGlassBand(x - wt, y + h, w + 2 * wt, wt);
    drawGlassBand(x - wt, y, wt, corner);
    drawGlassBand(x - wt, y + h - corner, wt, corner);
    drawMeshBand(x - wt, y + corner, wt, h - 2 * corner);
    drawGlassBand(x + w, y, wt, corner);
    drawGlassBand(x + w, y + h - corner, wt, corner);
    drawMeshBand(x + w, y + corner, wt, h - 2 * corner);
    const lx = x - wt / 2, rx = x + w + wt / 2;
    for (const by of [y, y + corner, netY, y + h - corner, y + h]) { drawBeam(lx, by, wt); drawBeam(rx, by, wt); }
  }

  // ---------- Корт ----------
  function drawCourt() {
    const { x, y, w, h } = court;
    const line = getVar('--court-line') || 'rgba(224,255,247,0.9)';
    const surface = getVar('--court') || '#123f45';
    const glow = getVar('--court-glow') || '#14b8a6';

    gfx.save();
    gfx.shadowColor = glow; gfx.shadowBlur = Math.max(14, w * 0.06);
    roundRectPath(x, y, w, h, 8);
    gfx.fillStyle = surface; gfx.fill();
    gfx.restore();

    gfx.save();
    roundRectPath(x, y, w, h, 8); gfx.clip();
    const grad = gfx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, 'rgba(0,0,0,0.22)');
    grad.addColorStop(0.30, 'rgba(0,0,0,0)');
    grad.addColorStop(0.70, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.22)');
    gfx.fillStyle = grad; gfx.fillRect(x, y, w, h);
    gfx.restore();

    drawEnclosure(x, y, w, h);

    gfx.strokeStyle = line; gfx.lineCap = 'round'; gfx.lineJoin = 'round';
    const lw = Math.max(1.5, w * 0.011);
    gfx.lineWidth = lw;
    gfx.beginPath(); gfx.rect(x, y, w, h); gfx.stroke();

    const svcTop = y + h * 0.1525, svcBot = y + h * 0.8475;
    hLine(x, x + w, svcTop); hLine(x, x + w, svcBot);

    const cx = x + w / 2, netY = y + h / 2;
    vLine(cx, svcTop, netY); vLine(cx, netY, svcBot);

    gfx.save();
    gfx.strokeStyle = line; gfx.lineWidth = lw * 1.5;
    hLine(x, x + w, netY);
    gfx.strokeStyle = 'rgba(255,255,255,0.3)'; gfx.lineWidth = Math.max(1, lw * 0.5);
    gfx.setLineDash([3, 5]); hLine(x, x + w, netY); gfx.setLineDash([]);
    gfx.fillStyle = line; dot(x, netY, lw * 1.3); dot(x + w, netY, lw * 1.3);
    gfx.restore();
  }

  // ---------- Рисунки ----------
  function tracePoints(pts) {
    gfx.beginPath();
    const p0 = toPx(pts[0]); gfx.moveTo(p0.x, p0.y);
    if (pts.length === 2) { const p = toPx(pts[1]); gfx.lineTo(p.x, p.y); return; }
    for (let i = 1; i < pts.length - 1; i++) {
      const a = toPx(pts[i]), b = toPx(pts[i + 1]);
      gfx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    const last = toPx(pts[pts.length - 1]); gfx.lineTo(last.x, last.y);
  }

  function zoneRect(d) {
    const a = toPx(d.from), b = toPx(d.to);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    return { x, y, w, h, r: Math.max(4, Math.min(16, w / 2, h / 2)) };
  }
  function drawZone(d) {
    const { x, y, w, h, r } = zoneRect(d);
    roundRectPath(x, y, w, h, r);
    gfx.fillStyle = rgba(d.color, 0.15); gfx.fill();
    gfx.setLineDash([9, 6]); gfx.lineWidth = 2.5; gfx.strokeStyle = d.color; gfx.stroke();
    gfx.setLineDash([]);
  }

  function drawArrowEnd(d) {
    const n = d.points.length;
    const end = toPx(d.points[n - 1]);
    let ref = null;
    for (let i = n - 2; i >= 0; i--) {
      const p = toPx(d.points[i]);
      if (Math.hypot(end.x - p.x, end.y - p.y) > 10) { ref = p; break; }
    }
    if (!ref) ref = toPx(d.points[0]);
    drawArrowHead(ref, end, d.width);
  }
  function drawArrowHead(a, b, w) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = Math.max(12, w * 3.4), spread = Math.PI / 7;
    gfx.beginPath();
    gfx.moveTo(b.x, b.y);
    gfx.lineTo(b.x - len * Math.cos(ang - spread), b.y - len * Math.sin(ang - spread));
    gfx.lineTo(b.x - len * Math.cos(ang + spread), b.y - len * Math.sin(ang + spread));
    gfx.closePath(); gfx.fill();
  }

  function drawDrawing(d) {
    if (d.type === 'zone') { drawZone(d); return; }
    gfx.strokeStyle = d.color; gfx.fillStyle = d.color;
    gfx.lineWidth = d.width; gfx.lineCap = 'round'; gfx.lineJoin = 'round';
    if (d.points.length < 2) { const p = toPx(d.points[0]); dot(p.x, p.y, d.width / 2); return; }
    tracePoints(d.points); gfx.stroke();
    if (d.type === 'arrow') drawArrowEnd(d);
  }

  function drawSelectionGlow(d) {
    gfx.save();
    gfx.strokeStyle = 'rgba(52,211,153,0.5)'; gfx.lineCap = 'round'; gfx.lineJoin = 'round';
    if (d.type === 'zone') {
      const { x, y, w, h, r } = zoneRect(d);
      gfx.lineWidth = 6; roundRectPath(x, y, w, h, r); gfx.stroke();
    } else if (d.points.length < 2) {
      const p = toPx(d.points[0]); gfx.fillStyle = 'rgba(52,211,153,0.5)'; dot(p.x, p.y, (d.width + 9) / 2);
    } else {
      gfx.lineWidth = d.width + 9; tracePoints(d.points); gfx.stroke();
    }
    gfx.restore();
  }

  // Маркеры (перетаскиваемые) выделенного объекта
  function handlesPx(d) {
    if (d.type === 'zone') {
      const nx0 = Math.min(d.from.x, d.to.x), nx1 = Math.max(d.from.x, d.to.x);
      const ny0 = Math.min(d.from.y, d.to.y), ny1 = Math.max(d.from.y, d.to.y);
      const corners = [{ x: nx0, y: ny0 }, { x: nx1, y: ny0 }, { x: nx0, y: ny1 }, { x: nx1, y: ny1 }];
      return corners.map((c, i) => ({ px: toPx(c), kind: 'corner', opposite: corners[3 - i] }));
    }
    const last = d.points.length - 1;
    return [
      { px: toPx(d.points[0]), kind: 'pt', i: 0 },
      { px: toPx(d.points[last]), kind: 'pt', i: last },
    ];
  }
  function drawHandles(d) {
    for (const h of handlesPx(d)) {
      gfx.beginPath(); gfx.arc(h.px.x, h.px.y, 7, 0, Math.PI * 2);
      gfx.fillStyle = '#F4F7FB'; gfx.fill();
      gfx.lineWidth = 2.5; gfx.strokeStyle = '#34D399'; gfx.stroke();
    }
  }

  // ---------- Фишки ----------
  function drawToken(t) {
    const p = toPx(t);
    const r = tokenRadius();
    const color = t.team === 'a' ? (getVar('--team-a') || '#10b981') : (getVar('--team-b') || '#f43f5e');

    gfx.save();
    gfx.shadowColor = color; gfx.shadowBlur = r * 0.9;
    gfx.fillStyle = color; dot(p.x, p.y, r);
    gfx.restore();

    const gr = gfx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, r * 0.2, p.x, p.y, r);
    gr.addColorStop(0, lighten(color, 0.4)); gr.addColorStop(1, color);
    gfx.fillStyle = gr; dot(p.x, p.y, r);

    gfx.strokeStyle = 'rgba(255,255,255,0.92)';
    gfx.lineWidth = Math.max(1.5, r * 0.09);
    gfx.beginPath(); gfx.arc(p.x, p.y, r, 0, Math.PI * 2); gfx.stroke();

    // Номер — точное вертикальное центрирование по метрикам глифа
    gfx.fillStyle = '#fff';
    gfx.font = `700 ${Math.round(r * 1.04)}px Manrope, -apple-system, sans-serif`;
    gfx.textAlign = 'center';
    gfx.textBaseline = 'alphabetic';
    const m = gfx.measureText(t.label);
    const asc = m.actualBoundingBoxAscent || r * 0.36;
    const desc = m.actualBoundingBoxDescent || 0;
    gfx.fillText(t.label, p.x, p.y + (asc - desc) / 2);
  }

  // ---------- Render ----------
  function renderScene() {
    drawCourt();
    for (const d of state.drawings) {
      if (d === state.selected) drawSelectionGlow(d);
      drawDrawing(d);
    }
    if (state.selected) drawHandles(state.selected);
    for (const t of state.tokens) drawToken(t);
  }
  function render() {
    screenCtx.clearRect(0, 0, canvas.width, canvas.height);
    renderScene();
    positionSelectionUI();
  }

  // ---------- Взаимодействие ----------
  let active = null;

  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function hitToken(px, py) {
    const r = tokenRadius() + 8;
    for (let i = state.tokens.length - 1; i >= 0; i--) {
      const t = state.tokens[i]; const p = toPx(t);
      if ((px - p.x) ** 2 + (py - p.y) ** 2 <= r * r) return t;
    }
    return null;
  }
  function hitDrawing(px, py) {
    for (let i = state.drawings.length - 1; i >= 0; i--) {
      const d = state.drawings[i];
      const thr = d.type === 'zone' ? 10 : Math.max(16, d.width + 10);
      if (drawingHit(d, px, py, thr)) return d;
    }
    return null;
  }
  function hitHandle(px, py) {
    if (!state.selected) return null;
    for (const h of handlesPx(state.selected)) {
      if (Math.hypot(px - h.px.x, py - h.px.y) <= HANDLE_HIT) return h;
    }
    return null;
  }

  function onDown(e) {
    if (active) return;
    canvas.setPointerCapture(e.pointerId);
    const pos = pointerPos(e);

    if (state.tool === 'move') {
      // 1) маркер выделенного объекта (изменение формы)
      const h = hitHandle(pos.x, pos.y);
      if (h) { active = { pointerId: e.pointerId, mode: 'handle', drawing: state.selected, h, undoPushed: false }; haptic('light'); return; }
      // 2) фишка
      const t = hitToken(pos.x, pos.y);
      if (t) { select(null); active = { pointerId: e.pointerId, mode: 'drag', token: t, undoPushed: false }; haptic('light'); return; }
      // 3) объект
      const d = hitDrawing(pos.x, pos.y);
      if (d) { select(d); active = { pointerId: e.pointerId, mode: 'dragObj', drawing: d, last: toNorm(pos.x, pos.y), undoPushed: false }; haptic('light'); }
      else select(null);
      return;
    }

    if (state.tool === 'eraser') { active = { pointerId: e.pointerId, mode: 'erase' }; eraseAt(pos.x, pos.y); return; }

    select(null);
    const n = normPt(pos.x, pos.y);
    if (state.tool === 'pen' || state.tool === 'arrow') {
      pushUndo();
      const d = { type: state.tool, color: state.color, width: WIDTHS[state.width], points: [n] };
      state.drawings.push(d);
      active = { pointerId: e.pointerId, mode: 'path', drawing: d, undoPushed: true };
    } else if (state.tool === 'zone') {
      pushUndo();
      const d = { type: 'zone', color: state.color, from: n, to: { x: n.x, y: n.y } };
      state.drawings.push(d);
      active = { pointerId: e.pointerId, mode: 'zone', drawing: d, undoPushed: true };
      render();
    }
  }

  function onMove(e) {
    if (!active || e.pointerId !== active.pointerId) return;
    const pos = pointerPos(e);
    // Ленивая запись истории: снимок делаем при первом реальном движении
    if (!active.undoPushed && (active.mode === 'drag' || active.mode === 'dragObj' || active.mode === 'handle')) {
      pushUndo(); active.undoPushed = true;
    }
    if (active.mode === 'drag') {
      const n = normPt(pos.x, pos.y);
      active.token.x = n.x; active.token.y = n.y; render();
    } else if (active.mode === 'dragObj') {
      const n = toNorm(pos.x, pos.y);
      translateDrawing(active.drawing, n.x - active.last.x, n.y - active.last.y);
      active.last = n; render();
    } else if (active.mode === 'handle') {
      const n = normPt(pos.x, pos.y);
      const d = active.drawing;
      if (d.type === 'zone') { d.from = { x: active.h.opposite.x, y: active.h.opposite.y }; d.to = { x: n.x, y: n.y }; }
      else { d.points[active.h.i] = n; }
      render();
    } else if (active.mode === 'path') {
      active.drawing.points.push(normPt(pos.x, pos.y)); render();
    } else if (active.mode === 'zone') {
      active.drawing.to = normPt(pos.x, pos.y); render();
    } else if (active.mode === 'erase') {
      eraseAt(pos.x, pos.y);
    }
  }

  function onUp(e) {
    if (!active || e.pointerId !== active.pointerId) return;
    const mode = active.mode;
    if (mode === 'path') {
      const d = active.drawing, pushed = active.undoPushed; active = null;
      if (d.points.length < 2 || pathLenPx(d) < 6) { if (pushed) undoStack.pop(); removeDrawing(d); render(); }
      else finishDraw(d);
      return;
    }
    if (mode === 'zone') {
      const d = active.drawing, pushed = active.undoPushed; active = null;
      const a = toPx(d.from), b = toPx(d.to);
      if (Math.abs(b.x - a.x) < 12 || Math.abs(b.y - a.y) < 12) { if (pushed) undoStack.pop(); removeDrawing(d); render(); }
      else finishDraw(d);
      return;
    }
    if (mode === 'drag' || mode === 'dragObj' || mode === 'handle') haptic('light');
    active = null;
  }

  function finishDraw(d) { setTool('move'); select(d); haptic('light'); }

  function pathLenPx(d) {
    let L = 0;
    for (let i = 1; i < d.points.length; i++) {
      const a = toPx(d.points[i - 1]), b = toPx(d.points[i]);
      L += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return L;
  }
  function translateDrawing(d, dx, dy) {
    if (d.type === 'zone') { d.from.x += dx; d.from.y += dy; d.to.x += dx; d.to.y += dy; }
    else for (const p of d.points) { p.x += dx; p.y += dy; }
  }
  function removeDrawing(d) {
    const i = state.drawings.indexOf(d);
    if (i >= 0) state.drawings.splice(i, 1);
    if (state.selected === d) select(null);
  }
  function eraseAt(px, py) {
    const d = hitDrawing(px, py);
    if (d) { pushUndo(); removeDrawing(d); haptic('rigid'); render(); }
  }
  function drawingHit(d, px, py, thr) {
    if (d.type === 'zone') {
      const a = toPx(d.from), b = toPx(d.to);
      return px >= Math.min(a.x, b.x) - thr && px <= Math.max(a.x, b.x) + thr &&
             py >= Math.min(a.y, b.y) - thr && py <= Math.max(a.y, b.y) + thr;
    }
    if (d.points.length === 1) { const a = toPx(d.points[0]); return Math.hypot(px - a.x, py - a.y) <= thr; }
    for (let i = 1; i < d.points.length; i++) {
      if (distToSeg(px, py, toPx(d.points[i - 1]), toPx(d.points[i])) <= thr) return true;
    }
    return false;
  }
  function distToSeg(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - a.x, py - a.y);
    let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  // ---------- Выделение / контекстные действия ----------
  objActions.querySelector('.del').addEventListener('click', () => {
    if (!state.selected) return;
    pushUndo();
    removeDrawing(state.selected); haptic('medium'); render();
  });
  objActions.querySelector('.dup').addEventListener('click', () => {
    if (!state.selected) return;
    pushUndo();
    const clone = JSON.parse(JSON.stringify(state.selected));
    translateDrawing(clone, 0.04, 0.04);
    state.drawings.push(clone); select(clone); haptic('light'); render();
  });

  function select(d) {
    state.selected = d;
    if (!d) objActions.classList.remove('show');
    render();
  }
  function bboxPx(d) {
    const pts = d.type === 'zone' ? [d.from, d.to] : d.points;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of pts) { const p = toPx(n); minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    return { minX, minY, maxX, maxY };
  }
  function positionSelectionUI() {
    if (!state.selected) return;
    const r = canvas.getBoundingClientRect();
    const b = bboxPx(state.selected);
    objActions.style.left = (r.left + (b.minX + b.maxX) / 2) + 'px';
    objActions.style.top = (r.top + b.minY - 14) + 'px';
    objActions.classList.add('show');
  }

  // ---------- Панель инструментов ----------
  const toolsEl = document.getElementById('tools');
  toolsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tool'); if (!btn) return;
    setTool(btn.dataset.tool); haptic('select');
  });
  function setTool(tool) {
    state.tool = tool;
    if (tool !== 'move') select(null);
    for (const b of toolsEl.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === tool);
  }

  const paletteEl = document.getElementById('palette');
  COLORS.forEach((c) => {
    const s = document.createElement('button');
    s.className = 'swatch'; s.style.background = c; s.style.color = c; s.dataset.color = c;
    if (c === state.color) s.classList.add('active');
    s.addEventListener('click', () => {
      state.color = c;
      for (const el of paletteEl.children) el.classList.toggle('active', el.dataset.color === c);
      if (state.selected) { pushUndo(); state.selected.color = c; render(); }
      else if (state.tool === 'move' || state.tool === 'eraser') setTool('pen');
      haptic('select');
    });
    paletteEl.appendChild(s);
  });

  const widthsEl = document.getElementById('widths');
  widthsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.width'); if (!btn) return;
    state.width = btn.dataset.width;
    for (const b of widthsEl.children) b.classList.toggle('active', b === btn);
    if (state.selected && isPath(state.selected)) { pushUndo(); state.selected.width = WIDTHS[state.width]; render(); }
    haptic('select');
  });

  // ---------- Навигатор кадров ----------
  const frPrev = document.getElementById('fr-prev');
  const frNext = document.getElementById('fr-next');
  const frAdd = document.getElementById('fr-add');
  const frDel = document.getElementById('fr-del');
  const frCur = document.getElementById('fr-cur');
  const frTotal = document.getElementById('fr-total');
  frPrev.addEventListener('click', () => gotoFrame(state.current - 1));
  frNext.addEventListener('click', () => gotoFrame(state.current + 1));
  frAdd.addEventListener('click', addFrame);
  frDel.addEventListener('click', deleteFrame);

  // ---------- Верхние действия ----------
  document.getElementById('btn-undo').addEventListener('click', undo);

  document.getElementById('btn-reset').addEventListener('click', () => {
    pushUndo();
    state.frames[state.current].tokens = defaultTokens();
    state.frames[state.current].drawings = [];
    loadFrame(state.current);
    render(); haptic('medium'); toast('Кадр сброшен');
  });

  document.getElementById('btn-share').addEventListener('click', shareImage);

  // ---------- Шаблоны ----------
  const TPL_KEY = 'padel_templates_v1';
  const sheet = document.getElementById('sheet');
  const sheetOverlay = document.getElementById('sheet-overlay');
  const tplList = document.getElementById('tpl-list');
  const tplName = document.getElementById('tpl-name');

  function loadTemplates() { try { return JSON.parse(localStorage.getItem(TPL_KEY)) || []; } catch (_) { return []; } }
  function persistTemplates(list) { try { localStorage.setItem(TPL_KEY, JSON.stringify(list)); return true; } catch (_) { return false; } }

  function openSheet() { renderTemplateList(); sheetOverlay.classList.add('open'); sheet.classList.add('open'); }
  function closeSheet() { sheetOverlay.classList.remove('open'); sheet.classList.remove('open'); if (tplName) tplName.blur(); }

  document.getElementById('btn-templates').addEventListener('click', () => { haptic('light'); openSheet(); });
  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  sheetOverlay.addEventListener('click', closeSheet);

  document.getElementById('tpl-save').addEventListener('click', () => {
    const list = loadTemplates();
    let name = (tplName.value || '').trim();
    if (!name) name = 'Схема ' + (list.length + 1);
    list.unshift({
      id: String(Date.now()) + '-' + Math.floor(Math.random() * 1000),
      name, createdAt: Date.now(),
      frames: JSON.parse(JSON.stringify(state.frames)),
    });
    if (!persistTemplates(list)) { toast('Не удалось сохранить'); return; }
    tplName.value = ''; renderTemplateList();
    haptic('medium'); toast('Схема сохранена');
  });

  function openTemplate(id) {
    const tpl = loadTemplates().find((t) => t.id === id);
    if (!tpl) return;
    let frames = tpl.frames;
    if (!frames || !frames.length) frames = [{ tokens: tpl.tokens || defaultTokens(), drawings: tpl.drawings || [] }];
    pushUndo();
    state.frames = JSON.parse(JSON.stringify(frames));
    loadFrame(0);
    render(); updateFrameUI(); closeSheet();
    haptic('medium'); toast('Схема загружена');
  }
  function deleteTemplate(id) {
    persistTemplates(loadTemplates().filter((t) => t.id !== id));
    renderTemplateList(); haptic('rigid'); toast('Схема удалена');
  }

  function fmtDate(ts) {
    try {
      const d = new Date(ts);
      return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) +
        ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch (_) { return ''; }
  }

  function renderTemplateList() {
    const list = loadTemplates();
    tplList.innerHTML = '';
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'tpl-empty';
      e.textContent = 'Пока нет сохранённых схем. Расставь кадры и нажми «Сохранить».';
      tplList.appendChild(e); return;
    }
    for (const tpl of list) {
      const row = document.createElement('div');
      row.className = 'tpl-row';
      const nFrames = tpl.frames ? tpl.frames.length : 1;
      row.innerHTML =
        '<div class="tpl-open"><div class="tpl-nm"></div>' +
        '<div class="tpl-meta">' + fmtDate(tpl.createdAt) + ' · ' + nFrames + ' кадр.</div></div>' +
        '<button class="tpl-del" aria-label="Удалить"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg></button>';
      row.querySelector('.tpl-nm').textContent = tpl.name;
      row.querySelector('.tpl-open').addEventListener('click', () => openTemplate(tpl.id));
      row.querySelector('.tpl-del').addEventListener('click', (ev) => { ev.stopPropagation(); deleteTemplate(tpl.id); });
      tplList.appendChild(row);
    }
  }

  // ---------- Экспорт ----------
  async function shareImage() {
    haptic('light');
    const wasSelected = state.selected;
    select(null);
    const blob = await exportBlob();
    if (wasSelected) select(wasSelected);
    if (!blob) { toast('Не удалось создать картинку'); return; }
    const file = new File([blob], 'padel-tactics.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Padel Tactics' }); return; } catch (_) {}
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'padel-tactics.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Картинка сохранена');
  }
  function exportBlob() {
    const scale = 2, outW = 700, outH = 1400;
    const off = document.createElement('canvas');
    off.width = outW * scale; off.height = outH * scale;
    const octx = off.getContext('2d');
    octx.scale(scale, scale);
    octx.fillStyle = getVar('--bg') || '#080D1A';
    octx.fillRect(0, 0, outW, outH);
    const pad = 40, cw = outW - pad * 2, ch = cw * 2;
    const tmpCourt = { x: pad, y: (outH - ch) / 2, w: cw, h: ch };
    return new Promise((resolve) => {
      withTarget(octx, tmpCourt, renderScene);
      off.toBlob((b) => resolve(b), 'image/png');
    });
  }

  // ---------- Утилиты ----------
  function getVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function lighten(hex, amt) {
    const { r, g, b } = hexToRgb(hex);
    const f = (v) => Math.round(v + (255 - v) * amt);
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  }
  function rgba(hex, a) { const { r, g, b } = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }
  function hexToRgb(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
  }

  // ---------- Клавиатура (десктоп) ----------
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
    if (mod) return;

    const nudge = (dx, dy) => { e.preventDefault(); if (!e.repeat) pushUndo(); translateDrawing(state.selected, dx, dy); render(); };
    switch (e.code) {
      case 'Delete': case 'Backspace':
        e.preventDefault();
        if (state.selected) { pushUndo(); removeDrawing(state.selected); haptic('medium'); render(); }
        return;
      case 'Escape': if (state.selected) select(null); return;
      case 'KeyV': setTool('move'); return;
      case 'KeyB': setTool('pen'); return;
      case 'KeyA': setTool('arrow'); return;
      case 'KeyZ': setTool('zone'); return;
      case 'KeyE': setTool('eraser'); return;
      case 'ArrowLeft': if (state.selected) nudge(-0.006, 0); else { e.preventDefault(); gotoFrame(state.current - 1); } return;
      case 'ArrowRight': if (state.selected) nudge(0.006, 0); else { e.preventDefault(); gotoFrame(state.current + 1); } return;
      case 'ArrowUp': if (state.selected) nudge(0, -0.006); return;
      case 'ArrowDown': if (state.selected) nudge(0, 0.006); return;
    }
  });

  // ---------- Инициализация ----------
  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(courtArea);

  loadFrame(0);
  setTool('move');
  updateFrameUI();
  for (const b of widthsEl.children) b.classList.toggle('active', b.dataset.width === state.width);
  requestAnimationFrame(resize);
})();
