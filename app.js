/* ============================================================
   Padel Tactics — тактическая доска (Telegram Mini App)
   Aurora-интерфейс, реалистичный падел-корт.

   Кадры (frames): state.tokens/state.drawings ссылаются на текущий
   кадр. Рисунки хранятся в нормализованных координатах [0..1] внутри
   прямоугольника корта. Поверх — вид (zoom/pan) через view-трансформ.

   Рисунки:
     pen   {type,color,dash,points:[{x,y}]}
     arrow {type,color,dash,from,to,off}     прямая, гнётся средней точкой
     lob   {type,color,dash,from,to,off}     «свеча» — дугой
     zone  {type,color,dash,alpha,from,to}   прямоугольная область
   ============================================================ */

(() => {
  'use strict';

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
      tg.ready(); tg.expand();
      tg.setHeaderColor('#080D1A'); tg.setBackgroundColor('#080D1A');
      if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    } catch (_) {}
  }

  // ---------- DOM ----------
  const canvas = document.getElementById('board');
  const screenCtx = canvas.getContext('2d');
  const courtArea = document.getElementById('court-area');
  const toastEl = document.getElementById('toast');
  const zoomResetBtn = document.getElementById('zoom-reset');

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
  const COLORS = ['#F4F7FB', '#FBBF24', '#38BDF8', '#FB7185', '#34D399', '#A5B4FC', '#12151c'];
  const WIDTHS = { thin: 0.0038, med: 0.006, thick: 0.0092 };
  const HANDLE_HIT = 22;
  const undoStack = [], redoStack = [];
  let clipboard = null;   // буфер для копирования объекта

  const state = {
    tool: 'move',
    color: '#F4F7FB',
    dash: 'solid',       // solid | dashed | dotted
    width: 'med',        // thin | med | thick
    zoneAlpha: 0.15,
    frames: [{ tokens: defaultTokens(), drawings: [] }],
    current: 0,
    tokens: null, drawings: null,
    selected: null,
  };
  const view = { scale: 1, tx: 0, ty: 0 };

  function defaultTokens() {
    const back = 0.075, front = 0.925, xl = 0.30, xr = 0.70;
    return [
      { id: 'B2', team: 'b', label: '2', x: xl, y: back },
      { id: 'B1', team: 'b', label: '1', x: xr, y: back },
      { id: 'A2', team: 'a', label: '2', x: xl, y: front },
      { id: 'A1', team: 'a', label: '1', x: xr, y: front },
    ];
  }
  const isArrow = (d) => d.type === 'arrow' || d.type === 'lob';

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
    loadFrame(i); render(); updateFrameUI(); haptic('select');
  }
  function addFrame() {
    pushUndo();
    state.frames.splice(state.current + 1, 0, { tokens: defaultTokens(), drawings: [] });
    loadFrame(state.current + 1);
    render(); updateFrameUI(); haptic('medium'); toast('Новый пустой кадр');
  }
  function duplicateFrame() {
    pushUndo();
    const src = state.frames[state.current];
    state.frames.splice(state.current + 1, 0, {
      tokens: JSON.parse(JSON.stringify(src.tokens)),
      drawings: JSON.parse(JSON.stringify(src.drawings)),
    });
    loadFrame(state.current + 1);
    render(); updateFrameUI(); haptic('medium'); toast('Копия кадра');
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

  // ---------- История ----------
  function snapshot() { return { frames: JSON.parse(JSON.stringify(state.frames)), current: state.current }; }
  function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0; }
  function restoreSnap(snap) {
    state.frames = JSON.parse(JSON.stringify(snap.frames));
    loadFrame(Math.min(snap.current, state.frames.length - 1));
    render(); updateFrameUI();
  }
  function undo() { if (!undoStack.length) { toast('Нечего отменить'); return; } redoStack.push(snapshot()); restoreSnap(undoStack.pop()); haptic('light'); }
  function redo() { if (!redoStack.length) { toast('Нечего вернуть'); return; } undoStack.push(snapshot()); restoreSnap(redoStack.pop()); haptic('light'); }

  // ---------- Размер / DPI ----------
  function resize() {
    const rect = courtArea.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    court = fitCourt(rect.width, rect.height, 14);
    render();
  }
  function fitCourt(W, H, pad) {
    const availW = W - pad * 2, availH = H - pad * 2, ratio = 0.5;
    let w, h;
    if (availW / availH > ratio) { h = availH; w = h * ratio; }
    else { w = availW; h = w / ratio; }
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  // ---------- Координаты / вид ----------
  const toPx = (n) => ({ x: court.x + n.x * court.w, y: court.y + n.y * court.h });
  const toNorm = (px, py) => ({ x: (px - court.x) / court.w, y: (py - court.y) / court.h });
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const normPt = (px, py) => { const n = toNorm(px, py); return { x: clamp01(n.x), y: clamp01(n.y) }; };
  const tokenRadius = () => court.w * 0.064;
  const lineW = (level) => Math.max(1.2, court.w * (WIDTHS[level] || WIDTHS.med));

  function clampView() {
    view.scale = clamp(view.scale, 1, 4);
    if (view.scale <= 1.001) { view.scale = 1; view.tx = 0; view.ty = 0; return; }
    const rect = canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height, s = view.scale, pad = 24;
    // границы корта на экране
    const top = view.ty + court.y * s, bottom = view.ty + (court.y + court.h) * s;
    const left = view.tx + court.x * s, right = view.tx + (court.x + court.w) * s;
    // по вертикали: если контент выше вьюпорта — свободный пан без больших зазоров, иначе центрируем
    if (bottom - top >= H - 2 * pad) {
      if (top > pad) view.ty -= (top - pad);
      else if (bottom < H - pad) view.ty += (H - pad - bottom);
    } else view.ty += (H - (top + bottom)) / 2;
    // по горизонтали
    if (right - left >= W - 2 * pad) {
      if (left > pad) view.tx -= (left - pad);
      else if (right < W - pad) view.tx += (W - pad - right);
    } else view.tx += (W - (left + right)) / 2;
  }

  // ---------- Стиль штриха ----------
  function applyDash(dash, w) {
    if (dash === 'dashed') { gfx.setLineDash([w * 2.4, w * 1.8]); gfx.lineCap = 'butt'; }
    else if (dash === 'dotted') { gfx.setLineDash([1, w * 2.2]); gfx.lineCap = 'round'; }
    else { gfx.setLineDash([]); gfx.lineCap = 'round'; }
  }
  function clearDash() { gfx.setLineDash([]); gfx.lineCap = 'round'; }

  // ---------- Ограждение (чёрная рама + стекло + решётка) ----------
  function hatchRect(rx, ry, rw, rh) {
    gfx.save();
    gfx.beginPath(); gfx.rect(rx, ry, rw, rh); gfx.clip();
    gfx.strokeStyle = 'rgba(210,222,235,0.22)'; gfx.lineWidth = 1;
    const s = 8, span = rw + rh;
    for (let i = -rh; i < span; i += s) {
      gfx.beginPath(); gfx.moveTo(rx + i, ry + rh); gfx.lineTo(rx + i + rh, ry); gfx.stroke();
      gfx.beginPath(); gfx.moveTo(rx + i, ry); gfx.lineTo(rx + i + rh, ry + rh); gfx.stroke();
    }
    gfx.restore();
  }
  // Панель стекла — гладкая тёмно-синяя с бликом
  function glassPanel(rx, ry, rw, rh) {
    gfx.fillStyle = '#3c567f';
    gfx.fillRect(rx, ry, rw, rh);
  }
  // Панель решётки — чёрная база + штриховка
  function meshPanel(rx, ry, rw, rh) {
    gfx.fillStyle = '#05080e'; gfx.fillRect(rx, ry, rw, rh);
    hatchRect(rx, ry, rw, rh);
  }
  // Балка-пост — белая (для контраста), с лёгкой гранью
  function beamPost(rx, ry, rw, rh) {
    gfx.fillStyle = '#eef2f9'; gfx.fillRect(rx, ry, rw, rh);
    gfx.fillStyle = 'rgba(255,255,255,0.6)'; gfx.fillRect(rx, ry, rw, Math.max(1, rh * 0.2));
    gfx.fillStyle = 'rgba(70,84,108,0.35)'; gfx.fillRect(rx, ry + rh - Math.max(1, rh * 0.22), rw, Math.max(1, rh * 0.22));
  }
  function drawEnclosure(x, y, w, h) {
    const ft = Math.max(7, w * 0.044);   // толщина рамы
    const bw = Math.max(4, ft * 0.85);   // ширина балки
    const g = bw / 2;
    const m0 = 0.17, m1 = 0.83;          // решётка — средняя часть боковых стен

    // 1. чёрная база
    gfx.fillStyle = '#05080e';
    gfx.fillRect(x - ft, y - ft, w + 2 * ft, ft);
    gfx.fillRect(x - ft, y + h, w + 2 * ft, ft);
    gfx.fillRect(x - ft, y, ft, h);
    gfx.fillRect(x + w, y, ft, h);

    // 2. СТЕКЛО — непрерывной рамкой: верх/низ во всю ширину + возвраты по бокам, огибая углы
    glassPanel(x - ft, y - ft, w + 2 * ft, ft);          // верх (с углами)
    glassPanel(x - ft, y + h, w + 2 * ft, ft);           // низ
    glassPanel(x - ft, y, ft, m0 * h);                   // левый верхний возврат
    glassPanel(x - ft, y + m1 * h, ft, (1 - m1) * h);    // левый нижний возврат
    glassPanel(x + w, y, ft, m0 * h);                    // правый верхний возврат
    glassPanel(x + w, y + m1 * h, ft, (1 - m1) * h);     // правый нижний возврат

    // 3. РЕШЁТКА — только середина боковых стен
    meshPanel(x - ft, y + m0 * h, ft, (m1 - m0) * h);
    meshPanel(x + w, y + m0 * h, ft, (m1 - m0) * h);

    // 4. БАЛКИ вдоль решётки (углы не разрываем — там непрерывное стекло)
    for (const p of [m0, 0.34, 0.5, 0.66, m1]) {
      const py = y + p * h;
      beamPost(x - ft, py - g, ft, bw);
      beamPost(x + w, py - g, ft, bw);
    }
    beamPost(x + w / 2 - g, y - ft, bw, ft);   // центральный пост, верх
    beamPost(x + w / 2 - g, y + h, bw, ft);     // центральный пост, низ

    // 5. грань рамы
    gfx.lineWidth = 1.5; gfx.strokeStyle = 'rgba(0,0,0,0.8)';
    gfx.strokeRect(x - ft, y - ft, w + 2 * ft, h + 2 * ft);
  }

  // ---------- Корт ----------
  function drawCourt() {
    const { x, y, w, h } = court;
    const line = 'rgba(255,255,255,0.92)';

    // свечение
    gfx.save();
    gfx.shadowColor = 'rgba(20,184,166,0.4)'; gfx.shadowBlur = Math.max(14, w * 0.06);
    gfx.fillStyle = '#347e84'; gfx.fillRect(x, y, w, h);
    gfx.restore();

    // покрытие + лёгкое затемнение у задних стен
    gfx.fillStyle = '#347e84'; gfx.fillRect(x, y, w, h);
    gfx.fillStyle = 'rgba(0,0,0,0.10)';
    gfx.fillRect(x, y, w, h * 0.14); gfx.fillRect(x, y + h * 0.86, w, h * 0.14);

    drawEnclosure(x, y, w, h);

    // разметка
    gfx.strokeStyle = line; gfx.lineCap = 'butt'; gfx.lineJoin = 'miter';
    const lw = Math.max(2, w * 0.013);
    gfx.lineWidth = lw;
    gfx.strokeRect(x, y, w, h);

    const svcTop = y + h * 0.1525, svcBot = y + h * 0.8475;
    hLine(x, x + w, svcTop); hLine(x, x + w, svcBot);
    const cx = x + w / 2, netY = y + h / 2, oh = h * 0.022;
    vLine(cx, svcTop - oh, svcBot + oh);

    // сетка
    gfx.save();
    gfx.strokeStyle = line; gfx.lineWidth = lw * 1.3;
    hLine(x, x + w, netY);
    gfx.strokeStyle = 'rgba(11,18,32,0.4)'; gfx.lineWidth = Math.max(1, lw * 0.5);
    gfx.setLineDash([2, 4]); hLine(x, x + w, netY); gfx.setLineDash([]);
    // столбик по центру сетки
    gfx.fillStyle = '#e8eef7';
    gfx.fillRect(cx - lw * 0.9, netY - lw * 1.6, lw * 1.8, lw * 3.2);
    gfx.restore();
  }
  const hLine = (x1, x2, yy) => { gfx.beginPath(); gfx.moveTo(x1, yy); gfx.lineTo(x2, yy); gfx.stroke(); };
  const vLine = (xx, y1, y2) => { gfx.beginPath(); gfx.moveTo(xx, y1); gfx.lineTo(xx, y2); gfx.stroke(); };
  const dot = (x, y, r) => { gfx.beginPath(); gfx.arc(x, y, r, 0, Math.PI * 2); gfx.fill(); };

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
  function zoneBox(d) {
    const a = toPx(d.from), b = toPx(d.to);
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }
  function drawZone(d) {
    const { x, y, w, h } = zoneBox(d);
    gfx.fillStyle = rgba(d.color, d.alpha != null ? d.alpha : 0.15);
    gfx.fillRect(x, y, w, h);
    gfx.strokeStyle = d.color; gfx.lineWidth = lineW(d.width); gfx.lineJoin = 'miter';
    applyDash(d.dash || 'solid', lineW(d.width));
    gfx.strokeRect(x, y, w, h);
    clearDash(); gfx.lineJoin = 'round';
  }
  const arrowCtrl = (d) => {
    const ox = d.off ? d.off.x : 0, oy = d.off ? d.off.y : 0;
    return { x: (d.from.x + d.to.x) / 2 + ox, y: (d.from.y + d.to.y) / 2 + oy };
  };
  function drawArrow(d) {
    if (!d.from || !d.to) return;
    const a = toPx(d.from), b = toPx(d.to), c = toPx(arrowCtrl(d)), w = lineW(d.width);
    gfx.strokeStyle = d.color; gfx.fillStyle = d.color; gfx.lineWidth = w; gfx.lineJoin = 'round';
    applyDash(d.dash || 'solid', w);
    gfx.beginPath(); gfx.moveTo(a.x, a.y); gfx.quadraticCurveTo(c.x, c.y, b.x, b.y); gfx.stroke();
    clearDash();
    drawArrowHead(c, b, w);
  }
  function drawArrowHead(a, b, w) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = Math.max(7, w * 5.5), spread = Math.PI / 7;
    gfx.beginPath();
    gfx.moveTo(b.x, b.y);
    gfx.lineTo(b.x - len * Math.cos(ang - spread), b.y - len * Math.sin(ang - spread));
    gfx.lineTo(b.x - len * Math.cos(ang + spread), b.y - len * Math.sin(ang + spread));
    gfx.closePath(); gfx.fill();
  }
  function drawPen(d) {
    const w = lineW(d.width);
    gfx.strokeStyle = d.color; gfx.fillStyle = d.color; gfx.lineWidth = w; gfx.lineJoin = 'round';
    applyDash(d.dash || 'solid', w);
    if (d.points.length < 2) { const p = toPx(d.points[0]); clearDash(); dot(p.x, p.y, w / 2); return; }
    tracePoints(d.points); gfx.stroke(); clearDash();
  }
  function drawText(d) {
    if (d._editing) return;
    const p = toPx(d), fs = Math.max(9, court.w * (d.size || 0.05));
    gfx.font = `700 ${fs}px Manrope, -apple-system, sans-serif`;
    gfx.textAlign = 'center'; gfx.textBaseline = 'middle'; gfx.lineJoin = 'round';
    gfx.lineWidth = Math.max(2, fs * 0.18); gfx.strokeStyle = 'rgba(0,0,0,0.5)';
    gfx.strokeText(d.text, p.x, p.y);
    gfx.fillStyle = d.color; gfx.fillText(d.text, p.x, p.y);
  }
  function textBox(d) {
    const p = toPx(d), fs = Math.max(9, court.w * (d.size || 0.05));
    gfx.font = `700 ${fs}px Manrope, sans-serif`;
    const wpx = gfx.measureText(d.text || '').width, hpx = fs * 1.25;
    return { x: p.x - wpx / 2, y: p.y - hpx / 2, w: wpx, h: hpx };
  }
  function drawDrawing(d) {
    if (d.type === 'zone') drawZone(d);
    else if (d.type === 'text') drawText(d);
    else if (isArrow(d)) drawArrow(d);
    else drawPen(d);
  }

  function drawSelectionGlow(d) {
    gfx.save();
    gfx.strokeStyle = 'rgba(52,211,153,0.55)'; gfx.lineCap = 'round'; gfx.lineJoin = 'round';
    const w = lineW(d.width) + 9;
    if (d.type === 'zone') {
      const { x, y, w: bw, h: bh } = zoneBox(d);
      gfx.lineWidth = 6; gfx.strokeRect(x, y, bw, bh);
    } else if (d.type === 'text') {
      const b = textBox(d);
      gfx.lineWidth = 3; gfx.strokeRect(b.x - 6, b.y - 4, b.w + 12, b.h + 8);
    } else if (isArrow(d)) {
      const a = toPx(d.from), b = toPx(d.to), c = toPx(arrowCtrl(d));
      gfx.lineWidth = w; gfx.beginPath(); gfx.moveTo(a.x, a.y); gfx.quadraticCurveTo(c.x, c.y, b.x, b.y); gfx.stroke();
    } else if (d.points.length < 2) {
      const p = toPx(d.points[0]); gfx.fillStyle = 'rgba(52,211,153,0.55)'; dot(p.x, p.y, w / 2);
    } else { gfx.lineWidth = w; tracePoints(d.points); gfx.stroke(); }
    gfx.restore();
  }
  function handlesPx(d) {
    if (d.type === 'zone') {
      const nx0 = Math.min(d.from.x, d.to.x), nx1 = Math.max(d.from.x, d.to.x);
      const ny0 = Math.min(d.from.y, d.to.y), ny1 = Math.max(d.from.y, d.to.y);
      const corners = [{ x: nx0, y: ny0 }, { x: nx1, y: ny0 }, { x: nx0, y: ny1 }, { x: nx1, y: ny1 }];
      return corners.map((c, i) => ({ px: toPx(c), kind: 'corner', opposite: corners[3 - i] }));
    }
    if (isArrow(d)) {
      return [
        { px: toPx(d.from), kind: 'from' },
        { px: toPx(d.to), kind: 'to' },
        { px: toPx(arrowCtrl(d)), kind: 'ctrl' },
      ];
    }
    if (d.type === 'text') return [];
    const last = d.points.length - 1;
    return [{ px: toPx(d.points[0]), kind: 'pt', i: 0 }, { px: toPx(d.points[last]), kind: 'pt', i: last }];
  }
  function drawHandles(d) {
    for (const hh of handlesPx(d)) {
      const ctrl = hh.kind === 'ctrl';
      gfx.beginPath(); gfx.arc(hh.px.x, hh.px.y, ctrl ? 6 : 7, 0, Math.PI * 2);
      gfx.fillStyle = ctrl ? '#34D399' : '#F4F7FB'; gfx.fill();
      gfx.lineWidth = 2.5; gfx.strokeStyle = ctrl ? '#F4F7FB' : '#34D399'; gfx.stroke();
    }
  }

  // ---------- Фишки ----------
  function drawToken(t) {
    const p = toPx(t), r = tokenRadius();
    const color = t.team === 'a' ? '#10b981' : '#f43f5e';
    gfx.save();
    gfx.shadowColor = color; gfx.shadowBlur = r * 0.9;
    gfx.fillStyle = color; dot(p.x, p.y, r);
    gfx.restore();
    const gr = gfx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, r * 0.2, p.x, p.y, r);
    gr.addColorStop(0, lighten(color, 0.4)); gr.addColorStop(1, color);
    gfx.fillStyle = gr; dot(p.x, p.y, r);
    gfx.strokeStyle = 'rgba(255,255,255,0.92)'; gfx.lineWidth = Math.max(1.5, r * 0.09);
    gfx.beginPath(); gfx.arc(p.x, p.y, r, 0, Math.PI * 2); gfx.stroke();
    gfx.fillStyle = '#fff';
    gfx.font = `700 ${Math.round(r * 1.04)}px Manrope, -apple-system, sans-serif`;
    gfx.textAlign = 'center'; gfx.textBaseline = 'alphabetic';
    const m = gfx.measureText(t.label);
    const asc = m.actualBoundingBoxAscent || r * 0.36, desc = m.actualBoundingBoxDescent || 0;
    gfx.fillText(t.label, p.x, p.y + (asc - desc) / 2);
  }

  // ---------- Render ----------
  function renderScene() {
    drawCourt();
    // зоны — нижний слой, стрелки/свечи/линии/текст — выше
    for (const d of state.drawings) if (d.type === 'zone') { if (d === state.selected) drawSelectionGlow(d); drawDrawing(d); }
    for (const d of state.drawings) if (d.type !== 'zone') { if (d === state.selected) drawSelectionGlow(d); drawDrawing(d); }
    if (state.selected) drawHandles(state.selected);
    for (const t of state.tokens) drawToken(t);
  }
  function render() {
    screenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    screenCtx.clearRect(0, 0, canvas.width, canvas.height);
    screenCtx.save();
    screenCtx.translate(view.tx, view.ty);
    screenCtx.scale(view.scale, view.scale);
    renderScene();
    screenCtx.restore();
    positionSelectionUI();
    zoomResetBtn.classList.toggle('show', view.scale > 1.01);
  }

  // ---------- Указатель / вид ----------
  const pointers = new Map();
  let pinch = null;
  let active = null;

  function screenPos(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function worldPos(e) { const s = screenPos(e); return { x: (s.x - view.tx) / view.scale, y: (s.y - view.ty) / view.scale }; }
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });

  function startPinch() { const it = [...pointers.values()]; pinch = { d0: dist(it[0], it[1]), m0: mid(it[0], it[1]), v0: { ...view } }; }
  function updatePinch() {
    const it = [...pointers.values()]; const d = dist(it[0], it[1]), m = mid(it[0], it[1]);
    const f = d / (pinch.d0 || 1);
    const newScale = clamp(pinch.v0.scale * f, 1, 4);
    const wx = (pinch.m0.x - pinch.v0.tx) / pinch.v0.scale, wy = (pinch.m0.y - pinch.v0.ty) / pinch.v0.scale;
    view.scale = newScale; view.tx = m.x - wx * newScale; view.ty = m.y - wy * newScale;
    clampView(); render();
  }
  function zoomAt(s, factor) {
    const newScale = clamp(view.scale * factor, 1, 4), f = newScale / view.scale;
    view.tx = s.x - (s.x - view.tx) * f; view.ty = s.y - (s.y - view.ty) * f; view.scale = newScale;
    clampView(); render();
  }
  function abortActive() {
    if (!active) return;
    if (active.drawing && (active.mode === 'path' || active.mode === 'arrow' || active.mode === 'lob' || active.mode === 'zone')) {
      if (active.undoPushed) undoStack.pop();
      removeDrawing(active.drawing);
    }
    active = null; render();
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, screenPos(e));
    if (pointers.size === 2) { abortActive(); startPinch(); return; }
    if (pointers.size > 2) return;
    singleDown(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, screenPos(e));
    if (pinch && pointers.size >= 2) { updatePinch(); return; }
    singleMove(e);
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pinch && pointers.size < 2) pinch = null;
    singleUp(e);
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) zoomAt(screenPos(e), e.deltaY < 0 ? 1.12 : 1 / 1.12);   // пинч на трекпаде / Ctrl+колесо
    else { view.tx -= e.deltaX; view.ty -= e.deltaY; clampView(); render(); }  // прокрутка = пан
  }, { passive: false });
  canvas.addEventListener('dblclick', (e) => {
    const pos = worldPos(e);
    const d = hitDrawing(pos.x, pos.y);
    if (d && d.type === 'text') {
      const r = canvas.getBoundingClientRect(), scr = screenPos(e);
      select(d);
      openTextEditor(r.left + scr.x, r.top + scr.y, { x: d.x, y: d.y }, d);
      return;
    }
    view.scale = 1; view.tx = 0; view.ty = 0; render();
  });
  zoomResetBtn.addEventListener('click', () => { view.scale = 1; view.tx = 0; view.ty = 0; render(); haptic('light'); });

  function hitToken(px, py) {
    const r = tokenRadius() + 8;
    for (let i = state.tokens.length - 1; i >= 0; i--) {
      const t = state.tokens[i], p = toPx(t);
      if ((px - p.x) ** 2 + (py - p.y) ** 2 <= r * r) return t;
    }
    return null;
  }
  function hitDrawing(px, py) {
    const test = (d) => {
      const thr = (d.type === 'zone' || d.type === 'text' ? 8 : Math.max(16, lineW(d.width) + 10)) / view.scale;
      return drawingHit(d, px, py, thr);
    };
    // сначала верхний слой (не зоны), затем зоны (нижний слой)
    for (let i = state.drawings.length - 1; i >= 0; i--) { const d = state.drawings[i]; if (d.type !== 'zone' && test(d)) return d; }
    for (let i = state.drawings.length - 1; i >= 0; i--) { const d = state.drawings[i]; if (d.type === 'zone' && test(d)) return d; }
    return null;
  }
  function hitHandle(px, py) {
    if (!state.selected) return null;
    const R = HANDLE_HIT / view.scale;
    for (const hh of handlesPx(state.selected)) if (Math.hypot(px - hh.px.x, py - hh.px.y) <= R) return hh;
    return null;
  }

  function singleDown(e) {
    if (active) return;
    const pos = worldPos(e);
    if (state.tool === 'move') {
      const hh = hitHandle(pos.x, pos.y);
      if (hh) { active = { pointerId: e.pointerId, mode: 'handle', drawing: state.selected, h: hh, undoPushed: false }; haptic('light'); return; }
      const t = hitToken(pos.x, pos.y);
      if (t) { select(null); active = { pointerId: e.pointerId, mode: 'drag', token: t, undoPushed: false }; haptic('light'); return; }
      const d = hitDrawing(pos.x, pos.y);
      if (d) { select(d); active = { pointerId: e.pointerId, mode: 'dragObj', drawing: d, last: pos, undoPushed: false }; haptic('light'); return; }
      if (view.scale > 1) { select(null); active = { pointerId: e.pointerId, mode: 'pan', lastScreen: screenPos(e) }; return; }
      select(null);
      return;
    }
    if (state.tool === 'text') {
      const r = canvas.getBoundingClientRect(), scr = screenPos(e);
      openTextEditor(r.left + scr.x, r.top + scr.y, normPt(pos.x, pos.y), null);
      return;
    }
    select(null);
    const n = normPt(pos.x, pos.y);
    if (state.tool === 'pen') {
      pushUndo();
      const d = { type: 'pen', color: state.color, dash: state.dash, width: state.width, points: [n] };
      state.drawings.push(d);
      active = { pointerId: e.pointerId, mode: 'path', drawing: d, undoPushed: true };
    } else if (state.tool === 'arrow' || state.tool === 'lob') {
      pushUndo();
      const d = { type: state.tool, color: state.color, dash: state.tool === 'lob' ? 'dotted' : state.dash, width: state.width, from: n, to: { x: n.x, y: n.y }, off: { x: 0, y: 0 } };
      state.drawings.push(d);
      active = { pointerId: e.pointerId, mode: state.tool, drawing: d, undoPushed: true };
      render();
    } else if (state.tool === 'zone') {
      pushUndo();
      const d = { type: 'zone', color: state.color, dash: state.dash, width: state.width, alpha: state.zoneAlpha, from: n, to: { x: n.x, y: n.y } };
      state.drawings.push(d);
      active = { pointerId: e.pointerId, mode: 'zone', drawing: d, undoPushed: true };
      render();
    }
  }
  function singleMove(e) {
    if (!active || e.pointerId !== active.pointerId) return;
    const pos = worldPos(e);
    if (!active.undoPushed && (active.mode === 'drag' || active.mode === 'dragObj' || active.mode === 'handle')) { pushUndo(); active.undoPushed = true; }
    if (active.mode === 'drag') { const n = normPt(pos.x, pos.y); active.token.x = n.x; active.token.y = n.y; render(); }
    else if (active.mode === 'dragObj') {
      const n = toNorm(pos.x, pos.y), l = toNorm(active.last.x, active.last.y);
      translateDrawing(active.drawing, n.x - l.x, n.y - l.y);
      active.last = pos; render();
    }
    else if (active.mode === 'handle') {
      const n = normPt(pos.x, pos.y), d = active.drawing, k = active.h.kind;
      if (d.type === 'zone') { d.from = { x: active.h.opposite.x, y: active.h.opposite.y }; d.to = { x: n.x, y: n.y }; }
      else if (isArrow(d)) {
        if (k === 'from') d.from = { x: n.x, y: n.y };
        else if (k === 'to') d.to = { x: n.x, y: n.y };
        else d.off = { x: n.x - (d.from.x + d.to.x) / 2, y: n.y - (d.from.y + d.to.y) / 2 };
      } else d.points[active.h.i] = n;
      render();
    }
    else if (active.mode === 'pan') {
      const sc = screenPos(e);
      view.tx += sc.x - active.lastScreen.x; view.ty += sc.y - active.lastScreen.y;
      active.lastScreen = sc; clampView(); render();
    }
    else if (active.mode === 'path') { active.drawing.points.push(normPt(pos.x, pos.y)); render(); }
    else if (active.mode === 'arrow' || active.mode === 'lob' || active.mode === 'zone') { active.drawing.to = normPt(pos.x, pos.y); render(); }
  }
  function singleUp(e) {
    if (!active || e.pointerId !== active.pointerId) return;
    const mode = active.mode;
    if (mode === 'path') {
      const d = active.drawing, pushed = active.undoPushed; active = null;
      if (d.points.length < 2 || pathLenPx(d) < 6) { if (pushed) undoStack.pop(); removeDrawing(d); render(); } else finishDraw(d);
      return;
    }
    if (mode === 'arrow' || mode === 'lob') {
      const d = active.drawing, pushed = active.undoPushed; active = null;
      const a = toPx(d.from), b = toPx(d.to);
      if (Math.hypot(b.x - a.x, b.y - a.y) < 10) { if (pushed) undoStack.pop(); removeDrawing(d); render(); }
      else { if (mode === 'lob') applyLobArc(d); finishDraw(d); }
      return;
    }
    if (mode === 'zone') {
      const d = active.drawing, pushed = active.undoPushed; active = null;
      const a = toPx(d.from), b = toPx(d.to);
      if (Math.abs(b.x - a.x) < 12 || Math.abs(b.y - a.y) < 12) { if (pushed) undoStack.pop(); removeDrawing(d); render(); } else finishDraw(d);
      return;
    }
    if (mode === 'drag' || mode === 'dragObj' || mode === 'handle') haptic('light');
    active = null;
  }

  // «Свеча»: задаём дугу перпендикулярно линии
  function applyLobArc(d) {
    const a = toPx(d.from), b = toPx(d.to);
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const px = (a.x + b.x) / 2 - dy / len * len * 0.22;
    const py = (a.y + b.y) / 2 + dx / len * len * 0.22;
    const nn = toNorm(px, py);
    d.off = { x: nn.x - (d.from.x + d.to.x) / 2, y: nn.y - (d.from.y + d.to.y) / 2 };
  }

  function finishDraw(d) { setTool('move'); select(d); haptic('light'); }
  function pathLenPx(d) { let L = 0; for (let i = 1; i < d.points.length; i++) { const a = toPx(d.points[i - 1]), b = toPx(d.points[i]); L += Math.hypot(b.x - a.x, b.y - a.y); } return L; }
  function translateDrawing(d, dx, dy) {
    if (d.type === 'text') { d.x += dx; d.y += dy; }
    else if (d.type === 'zone' || isArrow(d)) { d.from.x += dx; d.from.y += dy; d.to.x += dx; d.to.y += dy; }
    else for (const p of d.points) { p.x += dx; p.y += dy; }
  }
  function removeDrawing(d) { const i = state.drawings.indexOf(d); if (i >= 0) state.drawings.splice(i, 1); if (state.selected === d) select(null); }
  function drawingHit(d, px, py, thr) {
    if (d.type === 'text') {
      const b = textBox(d);
      return px >= b.x - thr && px <= b.x + b.w + thr && py >= b.y - thr && py <= b.y + b.h + thr;
    }
    if (d.type === 'zone') {
      const a = toPx(d.from), b = toPx(d.to);
      return px >= Math.min(a.x, b.x) - thr && px <= Math.max(a.x, b.x) + thr && py >= Math.min(a.y, b.y) - thr && py <= Math.max(a.y, b.y) + thr;
    }
    if (isArrow(d)) {
      const a = toPx(d.from), b = toPx(d.to), c = toPx(arrowCtrl(d));
      let prev = a;
      for (let i = 1; i <= 14; i++) {
        const t = i / 14, mt = 1 - t;
        const cur = { x: mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x, y: mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y };
        if (distToSeg(px, py, prev, cur) <= thr) return true; prev = cur;
      }
      return false;
    }
    if (d.points.length === 1) { const a = toPx(d.points[0]); return Math.hypot(px - a.x, py - a.y) <= thr; }
    for (let i = 1; i < d.points.length; i++) if (distToSeg(px, py, toPx(d.points[i - 1]), toPx(d.points[i])) <= thr) return true;
    return false;
  }
  function distToSeg(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - a.x, py - a.y);
    let t = ((px - a.x) * dx + (py - a.y) * dy) / len2; t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  // ---------- Выделение / контекст ----------
  objActions.querySelector('.del').addEventListener('click', () => { if (!state.selected) return; pushUndo(); removeDrawing(state.selected); haptic('medium'); render(); });
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
    updateStyleUIForSelection();
    render();
  }
  function bboxPx(d) {
    if (d.type === 'text') { const b = textBox(d); return { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h }; }
    const pts = d.type === 'zone' ? [d.from, d.to] : (isArrow(d) ? [d.from, d.to, arrowCtrl(d)] : d.points);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of pts) { const p = toPx(n); minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    return { minX, minY, maxX, maxY };
  }
  function positionSelectionUI() {
    if (!state.selected) return;
    const r = canvas.getBoundingClientRect(), b = bboxPx(state.selected);
    const cx = view.tx + (b.minX + b.maxX) / 2 * view.scale;
    const topY = view.ty + b.minY * view.scale;
    objActions.style.left = (r.left + cx) + 'px';
    objActions.style.top = (r.top + topY - 14) + 'px';
    objActions.classList.add('show');
  }

  // ---------- Текстовые заметки ----------
  const textInput = document.createElement('input');
  textInput.className = 'text-input';
  textInput.type = 'text';
  textInput.maxLength = 60;
  textInput.setAttribute('placeholder', 'Заметка…');
  textInput.setAttribute('autocomplete', 'off');
  document.body.appendChild(textInput);
  let editingText = null;

  function openTextEditor(sx, sy, n, existing) {
    editingText = { n, existing };
    textInput.value = existing ? existing.text : '';
    textInput.style.left = Math.max(8, Math.min(window.innerWidth - 190, sx - 16)) + 'px';
    textInput.style.top = Math.max(8, sy - 16) + 'px';
    textInput.style.display = 'block';
    if (existing) { existing._editing = true; render(); }
    setTimeout(() => { textInput.focus(); textInput.select(); }, 10);
  }
  function commitText() {
    if (!editingText) return;
    const ed = editingText; editingText = null;
    const val = textInput.value.trim();
    textInput.style.display = 'none';
    if (ed.existing) {
      ed.existing._editing = false;
      pushUndo();
      if (val) { ed.existing.text = val; select(ed.existing); }
      else { removeDrawing(ed.existing); }
    } else if (val) {
      pushUndo();
      const d = { type: 'text', color: state.color, text: val, x: ed.n.x, y: ed.n.y, size: 0.05 };
      state.drawings.push(d);
      setTool('move'); select(d);
    }
    render();
  }
  textInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commitText(); }
    else if (e.key === 'Escape') { const ed = editingText; editingText = null; textInput.style.display = 'none'; if (ed && ed.existing) ed.existing._editing = false; render(); }
  });
  textInput.addEventListener('blur', () => { if (editingText) commitText(); });

  // ---------- Инструменты ----------
  const toolsEl = document.getElementById('tools');
  toolsEl.addEventListener('click', (e) => { const btn = e.target.closest('.tool'); if (!btn) return; setTool(btn.dataset.tool); haptic('select'); });
  function setTool(tool) {
    state.tool = tool;
    if (tool !== 'move') select(null);
    for (const b of toolsEl.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === tool);
    updateStyleUIForSelection();
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
      else if (state.tool === 'move') setTool('pen');
      haptic('select');
    });
    paletteEl.appendChild(s);
  });

  // Стиль штриха (сплошная/пунктир/точки)
  const stylesEl = document.getElementById('styles');
  stylesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.style'); if (!btn) return;
    state.dash = btn.dataset.dash;
    for (const b of stylesEl.children) b.classList.toggle('active', b.dataset.dash === state.dash);
    if (state.selected) { pushUndo(); state.selected.dash = state.dash; render(); }
    haptic('select');
  });

  const widthsEl = document.getElementById('widths');
  widthsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.width'); if (!btn) return;
    state.width = btn.dataset.width;
    for (const b of widthsEl.children) b.classList.toggle('active', b.dataset.width === state.width);
    if (state.selected && state.selected.type !== 'text') { pushUndo(); state.selected.width = state.width; render(); }
    haptic('select');
  });

  // Заливка зоны (непрозрачность)
  const zoneAlphaWrap = document.getElementById('zone-alpha');
  const alphaRange = document.getElementById('alpha-range');
  alphaRange.addEventListener('pointerdown', () => { if (state.selected && state.selected.type === 'zone') pushUndo(); });
  alphaRange.addEventListener('input', () => {
    const a = parseInt(alphaRange.value, 10) / 100;
    state.zoneAlpha = a;
    if (state.selected && state.selected.type === 'zone') { state.selected.alpha = a; render(); }
  });

  function updateStyleUIForSelection() {
    const sel = state.selected;
    const dash = sel ? (sel.dash || 'solid') : state.dash;
    for (const b of stylesEl.children) b.classList.toggle('active', b.dataset.dash === dash);
    const width = sel ? (sel.width || 'med') : state.width;
    for (const b of widthsEl.children) b.classList.toggle('active', b.dataset.width === width);
    const isZone = (sel && sel.type === 'zone') || (!sel && state.tool === 'zone');
    zoneAlphaWrap.hidden = !isZone;
    widthsEl.hidden = isZone;
    if (isZone) {
      const a = sel && sel.type === 'zone' ? (sel.alpha != null ? sel.alpha : state.zoneAlpha) : state.zoneAlpha;
      alphaRange.value = Math.round(a * 100);
    }
    if (sel) {
      const cur = sel.color;
      for (const el of paletteEl.children) el.classList.toggle('active', el.dataset.color === cur);
    }
  }

  // ---------- Навигатор кадров ----------
  const frPrev = document.getElementById('fr-prev');
  const frNext = document.getElementById('fr-next');
  const frAdd = document.getElementById('fr-add');
  const frDup = document.getElementById('fr-dup');
  const frDel = document.getElementById('fr-del');
  const frCur = document.getElementById('fr-cur');
  const frTotal = document.getElementById('fr-total');
  frPrev.addEventListener('click', () => gotoFrame(state.current - 1));
  frNext.addEventListener('click', () => gotoFrame(state.current + 1));
  frAdd.addEventListener('click', addFrame);
  frDup.addEventListener('click', duplicateFrame);
  frDel.addEventListener('click', deleteFrame);

  // ---------- Верхние действия ----------
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-reset').addEventListener('click', () => {
    pushUndo();
    state.frames[state.current].tokens = defaultTokens();
    state.frames[state.current].drawings = [];
    loadFrame(state.current);
    render(); haptic('medium'); toast('Кадр очищен');
  });
  document.getElementById('btn-share').addEventListener('click', shareImage);

  // ---------- Шаблоны (CloudStorage + localStorage) ----------
  const TPL_KEY = 'padel_templates_v1';
  const CS_N = 'padel_tpl_n', CS_CHUNK = 'padel_tpl_';
  const sheet = document.getElementById('sheet');
  const sheetOverlay = document.getElementById('sheet-overlay');
  const tplList = document.getElementById('tpl-list');
  const tplName = document.getElementById('tpl-name');
  const tplUpdate = document.getElementById('tpl-update');
  let currentTpl = null;   // текущая загруженная схема (для «Обновить»)

  // ---------- Общие схемы (Supabase) ----------
  const SB_URL = 'https://eqjejfnzcpmwikaucuwn.supabase.co';
  const SB_KEY = 'sb_publishable_c0bGt_p4OMxBwFE9rB3eSw_ldA_KB25';
  const tplPublish = document.getElementById('tpl-publish');
  let ownerId = null;
  const sbHeaders = (extra) => Object.assign({ apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }, extra || {});
  async function sbFetch(path, opts) {
    try { const r = await fetch(SB_URL + '/rest/v1/' + path, opts); if (!r.ok) return null; const t = await r.text(); return t ? JSON.parse(t) : []; }
    catch (_) { return null; }
  }
  const myTgId = () => { try { return (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) ? tg.initDataUnsafe.user.id : null; } catch (_) { return null; } };
  const isOwner = () => { const me = myTgId(); return me != null && ownerId != null && String(me) === String(ownerId); };
  const canPublish = () => ownerId == null || isOwner();
  function updatePublishUI() { if (tplPublish) tplPublish.hidden = !canPublish(); }
  async function loadOwnerId() {
    const r = await sbFetch('app_config?select=value&key=eq.owner_id', { headers: sbHeaders() });
    ownerId = (Array.isArray(r) && r[0]) ? r[0].value : null;
    updatePublishUI();
  }
  async function claimOwner(id) {
    await sbFetch('app_config', { method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }), body: JSON.stringify({ key: 'owner_id', value: String(id) }) });
    ownerId = String(id);
  }
  async function loadPresets() {
    const r = await sbFetch('presets?select=*&order=created_at.desc', { headers: sbHeaders() });
    return Array.isArray(r) ? r : [];
  }
  async function publishPreset(name, frames) {
    const id = 'p' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    return sbFetch('presets', { method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
      body: JSON.stringify({ id, name, frames, owner_id: String(ownerId || myTgId() || '') }) });
  }
  async function deletePreset(id) {
    return sbFetch('presets?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: sbHeaders() });
  }

  function cloud() {
    try {
      if (tg && tg.CloudStorage && tg.CloudStorage.getItem && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9')) return tg.CloudStorage;
    } catch (_) {}
    return null;
  }
  function csGet(key) { return new Promise((r) => { try { cloud().getItem(key, (e, v) => r(e ? null : (v || null))); } catch (_) { r(null); } }); }
  function csSet(key, val) { return new Promise((r) => { try { cloud().setItem(key, val, (e, ok) => r(!e && !!ok)); } catch (_) { r(false); } }); }
  function csRemove(key) { return new Promise((r) => { try { cloud().removeItem(key, () => r(true)); } catch (_) { r(true); } }); }

  async function loadTemplates() {
    if (cloud()) {
      const n = parseInt((await csGet(CS_N)) || '0', 10) || 0;
      if (n > 0) {
        let s = '';
        for (let i = 0; i < n; i++) s += (await csGet(CS_CHUNK + i)) || '';
        try { const arr = JSON.parse(s); if (Array.isArray(arr)) return arr; } catch (_) {}
      }
      return [];
    }
    try { return JSON.parse(localStorage.getItem(TPL_KEY)) || []; } catch (_) { return []; }
  }
  async function persistTemplates(list) {
    const s = JSON.stringify(list);
    try { localStorage.setItem(TPL_KEY, s); } catch (_) {}
    if (cloud()) {
      const CHUNK = 3800, chunks = [];
      for (let i = 0; i < s.length; i += CHUNK) chunks.push(s.slice(i, i + CHUNK));
      if (!chunks.length) chunks.push('');
      const oldN = parseInt((await csGet(CS_N)) || '0', 10) || 0;
      for (let i = 0; i < chunks.length; i++) if (!(await csSet(CS_CHUNK + i, chunks[i]))) return false;
      await csSet(CS_N, String(chunks.length));
      for (let i = chunks.length; i < oldN; i++) await csRemove(CS_CHUNK + i);
      return true;
    }
    return true;
  }
  async function migrateLocalToCloud() {
    if (!cloud()) return;
    const n = parseInt((await csGet(CS_N)) || '0', 10) || 0;
    if (n > 0) return;
    let local = [];
    try { local = JSON.parse(localStorage.getItem(TPL_KEY)) || []; } catch (_) {}
    if (local.length) await persistTemplates(local);
  }

  function openSheet() {
    sheetOverlay.classList.add('open'); sheet.classList.add('open');
    mergeMode = false; mergeSel = [];
    mergeBar.hidden = true; mergeBtn.hidden = false; sheetSave.hidden = false;
    tplUpdate.hidden = !currentTpl;
    if (currentTpl) tplName.value = currentTpl.name;
    updatePublishUI();
    renderTemplateList();
  }
  function closeSheet() { sheetOverlay.classList.remove('open'); sheet.classList.remove('open'); if (tplName) tplName.blur(); }
  document.getElementById('btn-templates').addEventListener('click', () => { haptic('light'); openSheet(); });
  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  sheetOverlay.addEventListener('click', closeSheet);

  document.getElementById('tpl-save').addEventListener('click', async () => {
    const list = await loadTemplates();
    let name = (tplName.value || '').trim();
    if (!name) name = 'Схема ' + (list.length + 1);
    const id = String(Date.now()) + '-' + Math.floor(Math.random() * 1000);
    list.unshift({ id, name, createdAt: Date.now(), frames: JSON.parse(JSON.stringify(state.frames)) });
    if (!(await persistTemplates(list))) { toast('Не удалось сохранить'); return; }
    currentTpl = { id, name }; tplUpdate.hidden = false;
    renderTemplateList(); haptic('medium'); toast('Схема сохранена');
  });

  tplUpdate.addEventListener('click', async () => {
    if (!currentTpl) return;
    const list = await loadTemplates();
    const t = list.find((x) => x.id === currentTpl.id);
    if (!t) { toast('Схема не найдена'); currentTpl = null; tplUpdate.hidden = true; renderTemplateList(); return; }
    const nm = (tplName.value || '').trim();
    if (nm) t.name = nm;
    t.frames = JSON.parse(JSON.stringify(state.frames));
    t.createdAt = Date.now();
    currentTpl.name = t.name;
    if (!(await persistTemplates(list))) { toast('Не удалось обновить'); return; }
    renderTemplateList(); haptic('medium'); toast('Схема обновлена');
  });

  if (tplPublish) tplPublish.addEventListener('click', async () => {
    let name = (tplName.value || '').trim();
    if (!name) name = (currentTpl && currentTpl.name) || ('Общая ' + (Date.now() % 10000));
    toast('Публикую…');
    const res = await publishPreset(name, JSON.parse(JSON.stringify(state.frames)));
    if (!res) { toast('Не удалось опубликовать'); return; }
    if (ownerId == null) { const me = myTgId(); if (me != null) { await claimOwner(me); updatePublishUI(); } }
    haptic('medium'); toast('Опубликовано в общие');
    renderTemplateList();
  });

  function migrateFrames(frames) {
    for (const f of frames) {
      if (!f || !Array.isArray(f.drawings)) continue;
      for (const d of f.drawings) {
        if (d && (d.type === 'arrow' || d.type === 'lob') && Array.isArray(d.points) && d.points.length) {
          const p = d.points;
          d.from = { x: p[0].x, y: p[0].y }; d.to = { x: p[p.length - 1].x, y: p[p.length - 1].y }; d.off = { x: 0, y: 0 };
          delete d.points;
        }
        if (d && d.dash === undefined && d.type !== 'zone') d.dash = 'solid';
      }
    }
    return frames;
  }
  async function openTemplate(id) {
    const tpl = (await loadTemplates()).find((t) => t.id === id);
    if (!tpl) return;
    let frames = tpl.frames;
    if (!frames || !frames.length) frames = [{ tokens: tpl.tokens || defaultTokens(), drawings: tpl.drawings || [] }];
    pushUndo();
    state.frames = migrateFrames(JSON.parse(JSON.stringify(frames)));
    currentTpl = { id: tpl.id, name: tpl.name };
    loadFrame(0); render(); updateFrameUI(); closeSheet(); haptic('medium'); toast('Схема загружена — меняй и жми «Обновить»');
  }
  async function deleteTemplate(id) {
    const list = (await loadTemplates()).filter((t) => t.id !== id);
    await persistTemplates(list);
    if (currentTpl && currentTpl.id === id) { currentTpl = null; tplUpdate.hidden = true; }
    renderTemplateList(); haptic('rigid'); toast('Схема удалена');
  }

  function isBlankBoard() {
    return state.frames.length === 1 && (state.frames[0].drawings || []).length === 0 &&
      JSON.stringify(state.frames[0].tokens) === JSON.stringify(defaultTokens());
  }
  function framesOf(tpl) {
    let f = tpl.frames;
    if (!f || !f.length) f = [{ tokens: tpl.tokens || defaultTokens(), drawings: tpl.drawings || [] }];
    return migrateFrames(JSON.parse(JSON.stringify(f)));
  }
  function appendFrames(add) {
    pushUndo();
    if (isBlankBoard()) { state.frames = add; loadFrame(0); }
    else { const start = state.frames.length; state.frames.push(...add); loadFrame(start); }
    render(); updateFrameUI(); haptic('medium'); toast('Добавлено кадров: ' + add.length + ' (всего ' + state.frames.length + ')');
  }
  async function appendTemplate(id) { const tpl = (await loadTemplates()).find((t) => t.id === id); if (tpl) appendFrames(framesOf(tpl)); }
  function appendPreset(tpl) { appendFrames(framesOf(tpl)); }
  function openPreset(tpl) {
    pushUndo();
    state.frames = framesOf(tpl); currentTpl = null;
    loadFrame(0); render(); updateFrameUI(); closeSheet(); haptic('medium'); toast('Загружена: ' + tpl.name);
  }
  async function deleteSharedPreset(id) { await deletePreset(id); renderTemplateList(); haptic('rigid'); toast('Общая схема удалена'); }

  function fmtDate(ts) {
    try {
      const d = new Date(ts);
      return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch (_) { return ''; }
  }
  function makeRow(tpl, opts) {
    const row = document.createElement('div'); row.className = 'tpl-row';
    const nFrames = tpl.frames ? tpl.frames.length : 1;
    const del = opts.canDelete ? '<button class="tpl-del" aria-label="Удалить"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg></button>' : '';
    row.innerHTML = '<div class="tpl-open"><div class="tpl-nm"></div><div class="tpl-meta">' + fmtDate(tpl.createdAt || tpl.created_at) + ' · ' + nFrames + ' кадр.</div></div>' +
      '<button class="tpl-add" aria-label="Добавить кадры" title="Добавить кадры к текущей"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>' + del;
    row.querySelector('.tpl-nm').textContent = tpl.name;
    row.querySelector('.tpl-open').addEventListener('click', opts.onOpen);
    row.querySelector('.tpl-add').addEventListener('click', (ev) => { ev.stopPropagation(); opts.onAppend(); });
    if (opts.canDelete) row.querySelector('.tpl-del').addEventListener('click', (ev) => { ev.stopPropagation(); opts.onDelete(); });
    return row;
  }
  function sectionHeader(text) { const d = document.createElement('div'); d.className = 'tpl-section'; d.textContent = text; return d; }

  // ---------- Режим объединения (склейки) ----------
  const mergeBtn = document.getElementById('tpl-merge');
  const mergeBar = document.getElementById('merge-bar');
  const mergeCount = document.getElementById('merge-count');
  const mergeBuild = document.getElementById('merge-build');
  const mergeCancel = document.getElementById('merge-cancel');
  const sheetSave = document.querySelector('.sheet-save');
  let mergeMode = false, mergeSel = [];
  const inMerge = (id) => mergeSel.findIndex((t) => t.id === id);
  function updateMergeBar() {
    mergeCount.textContent = mergeSel.length ? ('Выбрано: ' + mergeSel.length) : 'Тапай схемы по порядку';
    mergeBuild.disabled = mergeSel.length < 1;
    mergeBuild.textContent = 'Собрать' + (mergeSel.length ? ' (' + mergeSel.length + ')' : '');
  }
  function enterMerge() { mergeMode = true; mergeSel = []; sheetSave.hidden = true; tplPublish.hidden = true; mergeBtn.hidden = true; mergeBar.hidden = false; updateMergeBar(); renderTemplateList(); }
  function exitMerge() { mergeMode = false; mergeSel = []; sheetSave.hidden = false; mergeBtn.hidden = false; mergeBar.hidden = true; updatePublishUI(); renderTemplateList(); }
  function toggleMergeSel(tpl) { const i = inMerge(tpl.id); if (i >= 0) mergeSel.splice(i, 1); else mergeSel.push(tpl); updateMergeBar(); renderTemplateList(); }
  mergeBtn.addEventListener('click', enterMerge);
  mergeCancel.addEventListener('click', exitMerge);
  mergeBuild.addEventListener('click', () => {
    if (!mergeSel.length) return;
    const frames = [];
    for (const tpl of mergeSel) frames.push(...framesOf(tpl));
    pushUndo();
    state.frames = frames; currentTpl = null;
    loadFrame(0); render(); updateFrameUI();
    exitMerge();
    haptic('medium'); toast('Собрано ' + frames.length + ' кадр(ов) — назови и сохрани/опубликуй');
    try { tplName.focus(); } catch (_) {}
  });
  function makeMergeRow(tpl) {
    const row = document.createElement('div'); row.className = 'tpl-row merge';
    const idx = inMerge(tpl.id), sel = idx >= 0;
    if (sel) row.classList.add('sel');
    const nFrames = tpl.frames ? tpl.frames.length : 1;
    row.innerHTML = '<div class="merge-badge">' + (sel ? (idx + 1) : '') + '</div>' +
      '<div class="tpl-open"><div class="tpl-nm"></div><div class="tpl-meta">' + nFrames + ' кадр.</div></div>';
    row.querySelector('.tpl-nm').textContent = tpl.name;
    row.addEventListener('click', () => toggleMergeSel(tpl));
    return row;
  }

  async function renderTemplateList() {
    tplList.innerHTML = '<div class="tpl-empty">Загрузка…</div>';
    const [shared, mine] = await Promise.all([loadPresets(), loadTemplates(), loadOwnerId()]);
    tplList.innerHTML = '';
    const section = (title, list, kind) => {
      if (kind === 'shared' && !list.length) return;
      tplList.appendChild(sectionHeader(title));
      if (!list.length) { const e = document.createElement('div'); e.className = 'tpl-empty'; e.textContent = 'Пока нет своих схем. Расставь кадры и нажми «Сохранить».'; tplList.appendChild(e); return; }
      for (const tpl of list) {
        if (mergeMode) { tplList.appendChild(makeMergeRow(tpl)); continue; }
        tplList.appendChild(makeRow(tpl, {
          canDelete: kind === 'shared' ? canPublish() : true,
          onOpen: kind === 'shared' ? () => openPreset(tpl) : () => openTemplate(tpl.id),
          onAppend: kind === 'shared' ? () => appendPreset(tpl) : () => appendTemplate(tpl.id),
          onDelete: kind === 'shared' ? () => deleteSharedPreset(tpl.id) : () => deleteTemplate(tpl.id),
        }));
      }
    };
    section('ОБЩИЕ СХЕМЫ', shared, 'shared');
    section('МОИ СХЕМЫ', mine, 'mine');
  }

  // ---------- Экспорт ----------
  async function shareImage() {
    haptic('light');
    const wasSelected = state.selected; select(null);
    const blob = await exportBlob();
    if (wasSelected) select(wasSelected);
    if (!blob) { toast('Не удалось создать картинку'); return; }
    const file = new File([blob], 'padel-tactics.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Padel Tactics' }); return; } catch (_) {} }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'padel-tactics.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000); toast('Картинка сохранена');
  }
  function exportBlob() {
    const scale = 2, outW = 700, outH = 1400;
    const off = document.createElement('canvas'); off.width = outW * scale; off.height = outH * scale;
    const octx = off.getContext('2d'); octx.scale(scale, scale);
    octx.fillStyle = '#080D1A'; octx.fillRect(0, 0, outW, outH);
    const pad = 46, cw = outW - pad * 2, ch = cw * 2;
    const tmpCourt = { x: pad, y: (outH - ch) / 2, w: cw, h: ch };
    return new Promise((resolve) => { withTarget(octx, tmpCourt, renderScene); off.toBlob((b) => resolve(b), 'image/png'); });
  }

  // ---------- Утилиты ----------
  function lighten(hex, amt) { const { r, g, b } = hexToRgb(hex); const f = (v) => Math.round(v + (255 - v) * amt); return `rgb(${f(r)},${f(g)},${f(b)})`; }
  function rgba(hex, a) { const { r, g, b } = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }
  function hexToRgb(hex) { let h = hex.replace('#', ''); if (h.length === 3) h = h.split('').map((x) => x + x).join(''); const n = parseInt(h, 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }

  let toastTimer = null;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600); }

  function pasteClipboard() {
    if (!clipboard) return;
    pushUndo();
    const c = JSON.parse(JSON.stringify(clipboard));
    translateDrawing(c, 0.04, 0.04);
    state.drawings.push(c); select(c); haptic('light'); render();
  }

  // ---------- Клавиатура (десктоп) ----------
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
    if (mod && e.code === 'KeyC') { e.preventDefault(); if (state.selected) { clipboard = JSON.parse(JSON.stringify(state.selected)); toast('Скопировано'); } return; }
    if (mod && e.code === 'KeyX') { e.preventDefault(); if (state.selected) { clipboard = JSON.parse(JSON.stringify(state.selected)); pushUndo(); removeDrawing(state.selected); haptic('medium'); render(); toast('Вырезано'); } return; }
    if (mod && e.code === 'KeyV') { e.preventDefault(); pasteClipboard(); return; }
    if (mod && e.code === 'KeyD') { e.preventDefault(); if (state.selected) { clipboard = JSON.parse(JSON.stringify(state.selected)); pasteClipboard(); } return; }
    if (mod && e.code === 'KeyS') { e.preventDefault(); return; }
    if (mod) return;
    const nudge = (dx, dy) => { e.preventDefault(); if (!e.repeat) pushUndo(); translateDrawing(state.selected, dx, dy); render(); };
    switch (e.code) {
      case 'Delete': case 'Backspace': e.preventDefault(); if (state.selected) { pushUndo(); removeDrawing(state.selected); haptic('medium'); render(); } return;
      case 'Escape': if (state.selected) select(null); return;
      case 'KeyV': setTool('move'); return;
      case 'KeyB': setTool('pen'); return;
      case 'KeyA': setTool('arrow'); return;
      case 'KeyS': setTool('lob'); return;
      case 'KeyZ': setTool('zone'); return;
      case 'KeyT': setTool('text'); return;
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
  for (const b of stylesEl.children) b.classList.toggle('active', b.dataset.dash === state.dash);
  for (const b of widthsEl.children) b.classList.toggle('active', b.dataset.width === state.width);
  migrateLocalToCloud();
  loadOwnerId();
  requestAnimationFrame(resize);
})();
