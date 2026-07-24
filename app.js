/* ============================================================
   Padel Tactics — тактическая доска (Telegram Mini App)
   Стиль: Aurora Glass.

   Координаты игроков и рисунков — нормализованные [0..1] внутри
   прямоугольника корта (устойчиво к ресайзу). Вся отрисовка идёт
   в переменную-цель `gfx` и прямоугольник `court`; их временно
   подменяют при экспорте в картинку.
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
      // Держим единый aurora-фон в шапке и подложке Telegram
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

  const state = {
    tool: 'move',
    color: '#FBBF24',
    width: 'med',
    drawings: [],     // {type:'pen',color,width,points:[{x,y}]} | {type:'line'|'arrow',color,width,from,to}
    tokens: defaultTokens(),
    selected: null,   // ссылка на выделенный рисунок
  };

  function defaultTokens() {
    // Корт вертикальный: сетка по центру (y=0.5). Команда B сверху, A снизу.
    return [
      { id: 'B1', team: 'b', label: '1', x: 0.30, y: 0.27 },
      { id: 'B2', team: 'b', label: '2', x: 0.70, y: 0.27 },
      { id: 'A1', team: 'a', label: '1', x: 0.30, y: 0.73 },
      { id: 'A2', team: 'a', label: '2', x: 0.70, y: 0.73 },
    ];
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
    const availW = W - pad * 2;
    const availH = H - pad * 2;
    const ratio = 0.5; // ширина:высота = 10м:20м
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

  // ---------- Ограждение: стекло и решётка ----------
  function drawGlassBand(rx, ry, rw, rh) {
    gfx.fillStyle = 'rgba(125,211,252,0.16)';
    gfx.fillRect(rx, ry, rw, rh);
    gfx.strokeStyle = 'rgba(186,230,253,0.5)';
    gfx.lineWidth = 1.2;
    gfx.strokeRect(rx + 0.6, ry + 0.6, rw - 1.2, rh - 1.2);
  }

  function drawMeshBand(rx, ry, rw, rh) {
    gfx.save();
    gfx.beginPath();
    gfx.rect(rx, ry, rw, rh);
    gfx.fillStyle = 'rgba(148,163,184,0.09)';
    gfx.fill();
    gfx.clip();
    gfx.strokeStyle = 'rgba(148,163,184,0.45)';
    gfx.lineWidth = 1;
    const s = 6, span = rw + rh;
    for (let i = -rh; i < span; i += s) {
      gfx.beginPath(); gfx.moveTo(rx + i, ry + rh); gfx.lineTo(rx + i + rh, ry); gfx.stroke();
      gfx.beginPath(); gfx.moveTo(rx + i, ry); gfx.lineTo(rx + i + rh, ry + rh); gfx.stroke();
    }
    gfx.restore();
  }

  function drawEnclosure(x, y, w, h) {
    const wt = Math.max(7, w * 0.028);   // толщина стены
    const corner = h * 0.14;             // длина стекла вдоль борта от угла (~2.8 м)
    // Задние стенки (полностью стекло, во всю ширину включая углы)
    drawGlassBand(x - wt, y - wt, w + 2 * wt, wt);
    drawGlassBand(x - wt, y + h, w + 2 * wt, wt);
    // Боковые: углы — стекло, середина — решётка
    // левая
    drawGlassBand(x - wt, y, wt, corner);
    drawGlassBand(x - wt, y + h - corner, wt, corner);
    drawMeshBand(x - wt, y + corner, wt, h - 2 * corner);
    // правая
    drawGlassBand(x + w, y, wt, corner);
    drawGlassBand(x + w, y + h - corner, wt, corner);
    drawMeshBand(x + w, y + corner, wt, h - 2 * corner);
  }

  // ---------- Корт ----------
  function drawCourt() {
    const { x, y, w, h } = court;
    const line = getVar('--court-line') || 'rgba(224,255,247,0.9)';
    const surface = getVar('--court') || '#123f45';
    const glow = getVar('--court-glow') || '#14b8a6';

    // Поверхность + мягкое свечение по краю
    gfx.save();
    gfx.shadowColor = glow;
    gfx.shadowBlur = Math.max(14, w * 0.06);
    roundRectPath(x, y, w, h, 8);
    gfx.fillStyle = surface;
    gfx.fill();
    gfx.restore();

    // Лёгкое затемнение у задних стен для объёма
    gfx.save();
    roundRectPath(x, y, w, h, 8);
    gfx.clip();
    const grad = gfx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, 'rgba(0,0,0,0.22)');
    grad.addColorStop(0.30, 'rgba(0,0,0,0)');
    grad.addColorStop(0.70, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.22)');
    gfx.fillStyle = grad;
    gfx.fillRect(x, y, w, h);
    gfx.restore();

    // Ограждение
    drawEnclosure(x, y, w, h);

    // Разметка
    gfx.strokeStyle = line;
    gfx.lineCap = 'round';
    gfx.lineJoin = 'round';
    const lw = Math.max(1.5, w * 0.011);
    gfx.lineWidth = lw;

    // Периметр
    gfx.beginPath();
    gfx.rect(x, y, w, h);
    gfx.stroke();

    // Линии подачи: 6.95 м от сетки → 3.05 м от задней стены → 0.1525 от края
    const svcTop = y + h * 0.1525;
    const svcBot = y + h * 0.8475;
    hLine(x, x + w, svcTop);
    hLine(x, x + w, svcBot);

    // Центральная линия подачи: от сетки до линии подачи (только центральная зона)
    const cx = x + w / 2;
    const netY = y + h / 2;
    vLine(cx, svcTop, netY);
    vLine(cx, netY, svcBot);

    // Сетка по центру
    gfx.save();
    gfx.strokeStyle = line;
    gfx.lineWidth = lw * 1.5;
    hLine(x, x + w, netY);
    gfx.strokeStyle = 'rgba(255,255,255,0.3)';
    gfx.lineWidth = Math.max(1, lw * 0.5);
    gfx.setLineDash([3, 5]);
    hLine(x, x + w, netY);
    gfx.setLineDash([]);
    gfx.fillStyle = line;
    dot(x, netY, lw * 1.3);
    dot(x + w, netY, lw * 1.3);
    gfx.restore();
  }

  // ---------- Рисунки ----------
  function pathFor(d) {
    if (d.type === 'pen') {
      gfx.beginPath();
      const f = toPx(d.points[0]);
      gfx.moveTo(f.x, f.y);
      for (let i = 1; i < d.points.length; i++) { const p = toPx(d.points[i]); gfx.lineTo(p.x, p.y); }
    } else {
      const a = toPx(d.from), b = toPx(d.to);
      gfx.beginPath();
      gfx.moveTo(a.x, a.y);
      gfx.lineTo(b.x, b.y);
    }
  }

  function drawSelectionGlow(d) {
    gfx.save();
    gfx.strokeStyle = 'rgba(52,211,153,0.45)';
    gfx.lineWidth = d.width + 9;
    gfx.lineCap = 'round';
    gfx.lineJoin = 'round';
    if (d.type === 'pen' && d.points.length < 2) {
      const p = toPx(d.points[0]); dot(p.x, p.y, (d.width + 9) / 2);
    } else {
      pathFor(d); gfx.stroke();
    }
    gfx.restore();
  }

  function drawDrawing(d) {
    gfx.strokeStyle = d.color;
    gfx.fillStyle = d.color;
    gfx.lineWidth = d.width;
    gfx.lineCap = 'round';
    gfx.lineJoin = 'round';

    if (d.type === 'pen') {
      if (d.points.length < 2) { const p = toPx(d.points[0]); dot(p.x, p.y, d.width / 2); return; }
      pathFor(d); gfx.stroke();
    } else {
      pathFor(d); gfx.stroke();
      if (d.type === 'arrow') { const a = toPx(d.from), b = toPx(d.to); drawArrowHead(a, b, d.width); }
    }
  }

  function drawArrowHead(a, b, w) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = Math.max(11, w * 3.2);
    const spread = Math.PI / 7;
    gfx.beginPath();
    gfx.moveTo(b.x, b.y);
    gfx.lineTo(b.x - len * Math.cos(ang - spread), b.y - len * Math.sin(ang - spread));
    gfx.lineTo(b.x - len * Math.cos(ang + spread), b.y - len * Math.sin(ang + spread));
    gfx.closePath();
    gfx.fill();
  }

  function drawHandles(d) {
    const pts = d.type === 'pen'
      ? [d.points[0], d.points[d.points.length - 1]]
      : [d.from, d.to];
    for (const n of pts) {
      const p = toPx(n);
      gfx.beginPath(); gfx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
      gfx.fillStyle = '#F4F7FB'; gfx.fill();
      gfx.lineWidth = 2; gfx.strokeStyle = '#34D399'; gfx.stroke();
    }
  }

  // ---------- Фишки ----------
  function drawToken(t) {
    const p = toPx(t);
    const r = tokenRadius();
    const color = t.team === 'a' ? (getVar('--team-a') || '#10b981') : (getVar('--team-b') || '#f43f5e');

    // Неоновое свечение
    gfx.save();
    gfx.shadowColor = color;
    gfx.shadowBlur = r * 0.9;
    gfx.fillStyle = color;
    dot(p.x, p.y, r);
    gfx.restore();

    // Градиентная заливка
    const gr = gfx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, r * 0.2, p.x, p.y, r);
    gr.addColorStop(0, lighten(color, 0.4));
    gr.addColorStop(1, color);
    gfx.fillStyle = gr;
    dot(p.x, p.y, r);

    // Ободок
    gfx.strokeStyle = 'rgba(255,255,255,0.92)';
    gfx.lineWidth = Math.max(1.5, r * 0.09);
    gfx.beginPath(); gfx.arc(p.x, p.y, r, 0, Math.PI * 2); gfx.stroke();

    // Номер
    gfx.fillStyle = '#fff';
    gfx.font = `700 ${Math.round(r * 1.02)}px ${getVar('--font-ui') || 'Manrope'}, sans-serif`;
    gfx.textAlign = 'center';
    gfx.textBaseline = 'middle';
    gfx.fillText(t.label, p.x, p.y + r * 0.05);
  }

  // ---------- Render ----------
  let preview = null;

  function renderScene() {
    drawCourt();
    for (const d of state.drawings) {
      if (d === state.selected) drawSelectionGlow(d);
      drawDrawing(d);
    }
    if (preview) drawDrawing(preview);
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
      const t = state.tokens[i];
      const p = toPx(t);
      if ((px - p.x) ** 2 + (py - p.y) ** 2 <= r * r) return t;
    }
    return null;
  }

  function hitDrawing(px, py) {
    for (let i = state.drawings.length - 1; i >= 0; i--) {
      const d = state.drawings[i];
      const thr = Math.max(12, d.width + 8);
      if (drawingHit(d, px, py, thr)) return d;
    }
    return null;
  }

  function onDown(e) {
    if (active) return;
    canvas.setPointerCapture(e.pointerId);
    const pos = pointerPos(e);

    if (state.tool === 'move') {
      const t = hitToken(pos.x, pos.y);
      if (t) { select(null); active = { pointerId: e.pointerId, mode: 'drag', token: t }; haptic('light'); return; }
      const d = hitDrawing(pos.x, pos.y);
      if (d) {
        select(d);
        active = { pointerId: e.pointerId, mode: 'dragObj', drawing: d, last: normPt(pos.x, pos.y), moved: false };
        haptic('light');
      } else {
        select(null);
      }
      return;
    }

    if (state.tool === 'eraser') {
      active = { pointerId: e.pointerId, mode: 'erase' };
      eraseAt(pos.x, pos.y);
      return;
    }

    // Инструменты рисования
    select(null);
    const n = normPt(pos.x, pos.y);
    if (state.tool === 'pen') {
      const d = { type: 'pen', color: state.color, width: WIDTHS[state.width], points: [n] };
      state.drawings.push(d);
      active = { pointerId: e.pointerId, mode: 'pen', drawing: d };
    } else if (state.tool === 'line' || state.tool === 'arrow') {
      active = { pointerId: e.pointerId, mode: state.tool, from: n, to: n };
      preview = { type: state.tool, color: state.color, width: WIDTHS[state.width], from: n, to: n };
      render();
    }
  }

  function onMove(e) {
    if (!active || e.pointerId !== active.pointerId) return;
    const pos = pointerPos(e);

    if (active.mode === 'drag') {
      const n = normPt(pos.x, pos.y);
      active.token.x = n.x; active.token.y = n.y;
      render();
    } else if (active.mode === 'dragObj') {
      const n = toNorm(pos.x, pos.y);
      const dx = n.x - active.last.x, dy = n.y - active.last.y;
      translateDrawing(active.drawing, dx, dy);
      active.last = n; active.moved = true;
      render();
    } else if (active.mode === 'pen') {
      active.drawing.points.push(normPt(pos.x, pos.y));
      render();
    } else if (active.mode === 'line' || active.mode === 'arrow') {
      const n = normPt(pos.x, pos.y);
      active.to = n; preview.to = n;
      render();
    } else if (active.mode === 'erase') {
      eraseAt(pos.x, pos.y);
    }
  }

  function onUp(e) {
    if (!active || e.pointerId !== active.pointerId) return;
    if (active.mode === 'line' || active.mode === 'arrow') {
      const dx = (active.to.x - active.from.x) * court.w;
      const dy = (active.to.y - active.from.y) * court.h;
      if (Math.hypot(dx, dy) > 6) {
        state.drawings.push({ type: active.mode, color: state.color, width: WIDTHS[state.width], from: active.from, to: active.to });
      }
      preview = null;
      render();
    } else if (active.mode === 'drag' || active.mode === 'dragObj') {
      haptic('light');
    }
    active = null;
  }

  function translateDrawing(d, dx, dy) {
    if (d.type === 'pen') {
      for (const p of d.points) { p.x += dx; p.y += dy; }
    } else {
      d.from.x += dx; d.from.y += dy;
      d.to.x += dx; d.to.y += dy;
    }
  }

  function eraseAt(px, py) {
    for (let i = state.drawings.length - 1; i >= 0; i--) {
      const d = state.drawings[i];
      if (drawingHit(d, px, py, Math.max(12, d.width + 8))) {
        if (d === state.selected) select(null);
        state.drawings.splice(i, 1);
        haptic('rigid');
        render();
        return;
      }
    }
  }

  function drawingHit(d, px, py, thr) {
    if (d.type === 'pen') {
      if (d.points.length === 1) { const a = toPx(d.points[0]); return Math.hypot(px - a.x, py - a.y) <= thr; }
      for (let i = 1; i < d.points.length; i++) {
        if (distToSeg(px, py, toPx(d.points[i - 1]), toPx(d.points[i])) <= thr) return true;
      }
      return false;
    }
    return distToSeg(px, py, toPx(d.from), toPx(d.to)) <= thr;
  }

  function distToSeg(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - a.x, py - a.y);
    let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  // ---------- Выделение объекта ----------
  const objActions = document.createElement('div');
  objActions.className = 'obj-actions';
  objActions.innerHTML =
    '<button class="dup" title="Дублировать"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>' +
    '<button class="del" title="Удалить"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg></button>';
  document.body.appendChild(objActions);

  objActions.querySelector('.del').addEventListener('click', () => {
    if (!state.selected) return;
    const i = state.drawings.indexOf(state.selected);
    if (i >= 0) state.drawings.splice(i, 1);
    select(null);
    haptic('medium');
    render();
  });
  objActions.querySelector('.dup').addEventListener('click', () => {
    if (!state.selected) return;
    const clone = JSON.parse(JSON.stringify(state.selected));
    translateDrawing(clone, 0.04, 0.04);
    state.drawings.push(clone);
    select(clone);
    haptic('light');
    render();
  });

  function select(d) {
    state.selected = d;
    if (!d) { objActions.classList.remove('show'); render(); return; }
    render();
  }

  function bboxPx(d) {
    const pts = d.type === 'pen' ? d.points : [d.from, d.to];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of pts) {
      const p = toPx(n);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
  }

  function positionSelectionUI() {
    if (!state.selected) return;
    const r = canvas.getBoundingClientRect();
    const b = bboxPx(state.selected);
    objActions.style.left = (r.left + (b.minX + b.maxX) / 2) + 'px';
    objActions.style.top = (r.top + b.minY - 12) + 'px';
    objActions.classList.add('show');
  }

  // ---------- Панель инструментов ----------
  const toolsEl = document.getElementById('tools');
  toolsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tool');
    if (!btn) return;
    setTool(btn.dataset.tool);
    haptic('select');
  });

  function setTool(tool) {
    state.tool = tool;
    if (tool !== 'move') select(null);
    for (const b of toolsEl.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === tool);
  }

  // Палитра
  const paletteEl = document.getElementById('palette');
  COLORS.forEach((c) => {
    const s = document.createElement('button');
    s.className = 'swatch';
    s.style.background = c;
    s.style.color = c;
    s.dataset.color = c;
    if (c === state.color) s.classList.add('active');
    s.addEventListener('click', () => {
      state.color = c;
      for (const el of paletteEl.children) el.classList.toggle('active', el.dataset.color === c);
      if (state.selected) { state.selected.color = c; render(); }
      else if (state.tool === 'move' || state.tool === 'eraser') setTool('pen');
      haptic('select');
    });
    paletteEl.appendChild(s);
  });

  // Толщина
  const widthsEl = document.getElementById('widths');
  widthsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.width');
    if (!btn) return;
    state.width = btn.dataset.width;
    for (const b of widthsEl.children) b.classList.toggle('active', b === btn);
    if (state.selected) { state.selected.width = WIDTHS[state.width]; render(); }
    haptic('select');
  });

  // ---------- Верхние действия ----------
  document.getElementById('btn-undo').addEventListener('click', () => {
    if (state.drawings.length) {
      const removed = state.drawings.pop();
      if (removed === state.selected) select(null);
      render(); haptic('light');
    } else toast('Нечего отменять');
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    if (!state.drawings.length) { toast('Рисунков нет'); return; }
    state.drawings = []; preview = null; select(null); render();
    haptic('medium'); toast('Рисунки очищены');
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    state.tokens = defaultTokens(); render();
    haptic('medium'); toast('Позиции сброшены');
  });

  document.getElementById('btn-share').addEventListener('click', shareImage);

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
  function hexToRgb(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
  }

  // ---------- Инициализация ----------
  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(courtArea);

  setTool('move');
  for (const b of widthsEl.children) b.classList.toggle('active', b.dataset.width === state.width);
  requestAnimationFrame(resize);
})();
