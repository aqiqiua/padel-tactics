/* ============================================================
   Padel Tactics — тактическая доска (Telegram Mini App)

   Координаты игроков/мяча и рисунков хранятся в нормализованном
   виде [0..1] внутри прямоугольника корта — это делает всё
   устойчивым к изменению размера экрана.

   Вся отрисовка идёт в переменную-цель `gfx` (текущий контекст)
   и прямоугольник `court`. Их временно подменяют при экспорте в
   картинку, переиспользуя тот же код отрисовки.
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

  function applyTheme() {
    if (!tg) return;
    const p = tg.themeParams || {};
    const root = document.documentElement.style;
    const map = {
      '--bg': p.bg_color,
      '--surface': p.secondary_bg_color,
      '--surface-2': p.section_bg_color || p.secondary_bg_color,
      '--text': p.text_color,
      '--hint': p.hint_color,
      '--accent': p.button_color || p.link_color,
    };
    for (const [k, v] of Object.entries(map)) if (v) root.setProperty(k, v);
    try {
      tg.setHeaderColor(p.bg_color || '#17212b');
      tg.setBackgroundColor(p.bg_color || '#17212b');
    } catch (_) {}
  }

  if (tg) {
    try {
      tg.ready();
      tg.expand();
      applyTheme();
      tg.onEvent('themeChanged', applyTheme);
      if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    } catch (_) {}
  }

  // ---------- DOM ----------
  const canvas = document.getElementById('board');
  const screenCtx = canvas.getContext('2d');
  const courtArea = document.getElementById('court-area');
  const toastEl = document.getElementById('toast');

  // ---------- Цель отрисовки ----------
  // gfx — текущий контекст, court — текущий прямоугольник корта (в px).
  let gfx = screenCtx;
  let court = { x: 0, y: 0, w: 0, h: 0 };
  let dpr = 1;

  function withTarget(newCtx, newCourt, fn) {
    const prevGfx = gfx, prevCourt = court;
    gfx = newCtx; court = newCourt;
    try { fn(); } finally { gfx = prevGfx; court = prevCourt; }
  }

  // ---------- Состояние ----------
  const COLORS = ['#ffffff', '#facc15', '#38bdf8', '#f87171', '#4ade80', '#111111'];
  const WIDTHS = { thin: 2.5, med: 4, thick: 6.5 };

  const state = {
    tool: 'move',
    color: '#facc15',
    width: 'med',
    drawings: [],          // {type:'pen', color, width, points:[{x,y}]}  |  {type:'line'|'arrow', color, width, from, to}
    tokens: defaultTokens(),
  };

  function defaultTokens() {
    // Корт вертикальный: сетка по центру (y=0.5). Команда B сверху, A снизу.
    return [
      { id: 'B1', kind: 'player', team: 'b', label: '1', x: 0.30, y: 0.26 },
      { id: 'B2', kind: 'player', team: 'b', label: '2', x: 0.70, y: 0.26 },
      { id: 'A1', kind: 'player', team: 'a', label: '1', x: 0.30, y: 0.74 },
      { id: 'A2', kind: 'player', team: 'a', label: '2', x: 0.70, y: 0.74 },
      { id: 'BALL', kind: 'ball', x: 0.50, y: 0.60 },
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
    court = fitCourt(rect.width, rect.height, 14);
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

  // ---------- Преобразования координат ----------
  const toPx = (n) => ({ x: court.x + n.x * court.w, y: court.y + n.y * court.h });
  const toNorm = (px, py) => ({ x: (px - court.x) / court.w, y: (py - court.y) / court.h });
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const normPt = (px, py) => { const n = toNorm(px, py); return { x: clamp01(n.x), y: clamp01(n.y) }; };

  function tokenRadius(t) {
    return t.kind === 'ball' ? court.w * 0.035 : court.w * 0.062;
  }

  // ---------- Примитивы (используют текущую цель gfx) ----------
  function roundRectPath(x, y, w, h, r) {
    gfx.beginPath();
    gfx.moveTo(x + r, y);
    gfx.arcTo(x + w, y, x + w, y + h, r);
    gfx.arcTo(x + w, y + h, x, y + h, r);
    gfx.arcTo(x, y + h, x, y, r);
    gfx.arcTo(x, y, x + w, y, r);
    gfx.closePath();
  }
  const strokeRectP = (x, y, w, h) => { gfx.beginPath(); gfx.rect(x, y, w, h); gfx.stroke(); };
  const hLine = (x1, x2, y) => { gfx.beginPath(); gfx.moveTo(x1, y); gfx.lineTo(x2, y); gfx.stroke(); };
  const vLine = (x, y1, y2) => { gfx.beginPath(); gfx.moveTo(x, y1); gfx.lineTo(x, y2); gfx.stroke(); };
  const dot = (x, y, r) => { gfx.beginPath(); gfx.arc(x, y, r, 0, Math.PI * 2); gfx.fill(); };

  // ---------- Отрисовка корта ----------
  function drawCourt() {
    const { x, y, w, h } = court;
    const line = getVar('--court-line') || '#f4f7f6';
    const surface = getVar('--court') || '#2b7a78';

    roundRectPath(x, y, w, h, 6);
    gfx.fillStyle = surface;
    gfx.fill();

    // Затемнение у задних стен для объёма
    gfx.save();
    roundRectPath(x, y, w, h, 6);
    gfx.clip();
    const grad = gfx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, 'rgba(0,0,0,0.16)');
    grad.addColorStop(0.28, 'rgba(0,0,0,0)');
    grad.addColorStop(0.72, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.16)');
    gfx.fillStyle = grad;
    gfx.fillRect(x, y, w, h);
    gfx.restore();

    gfx.strokeStyle = line;
    gfx.lineCap = 'round';
    gfx.lineJoin = 'round';
    const lw = Math.max(1.5, w * 0.012);
    gfx.lineWidth = lw;

    // Внешняя граница
    strokeRectP(x, y, w, h);

    // Линии подачи: 3 м от сетки → 0.15 от центра
    const svcTop = y + h * 0.35;
    const svcBot = y + h * 0.65;
    hLine(x, x + w, svcTop);
    hLine(x, x + w, svcBot);

    // Центральная линия: от линии подачи до задней стены (как в паделе)
    const cx = x + w / 2;
    vLine(cx, y, svcTop);
    vLine(cx, svcBot, y + h);

    // Сетка по центру
    const netY = y + h / 2;
    gfx.save();
    gfx.strokeStyle = line;
    gfx.lineWidth = lw * 1.4;
    hLine(x, x + w, netY);
    gfx.strokeStyle = 'rgba(255,255,255,0.35)';
    gfx.lineWidth = Math.max(1, lw * 0.5);
    gfx.setLineDash([3, 5]);
    hLine(x, x + w, netY);
    gfx.setLineDash([]);
    gfx.fillStyle = line;
    dot(x, netY, lw * 1.2);
    dot(x + w, netY, lw * 1.2);
    gfx.restore();
  }

  // ---------- Отрисовка рисунков ----------
  function drawDrawing(d) {
    gfx.strokeStyle = d.color;
    gfx.fillStyle = d.color;
    gfx.lineWidth = d.width;
    gfx.lineCap = 'round';
    gfx.lineJoin = 'round';

    if (d.type === 'pen') {
      if (d.points.length < 2) {
        const p = toPx(d.points[0]);
        dot(p.x, p.y, d.width / 2);
        return;
      }
      gfx.beginPath();
      const first = toPx(d.points[0]);
      gfx.moveTo(first.x, first.y);
      for (let i = 1; i < d.points.length; i++) {
        const p = toPx(d.points[i]);
        gfx.lineTo(p.x, p.y);
      }
      gfx.stroke();
    } else {
      const a = toPx(d.from), b = toPx(d.to);
      gfx.beginPath();
      gfx.moveTo(a.x, a.y);
      gfx.lineTo(b.x, b.y);
      gfx.stroke();
      if (d.type === 'arrow') drawArrowHead(a, b, d.width);
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

  // ---------- Отрисовка фишек ----------
  function drawToken(t) {
    const p = toPx(t);
    const r = tokenRadius(t);

    gfx.save();
    gfx.shadowColor = 'rgba(0,0,0,0.35)';
    gfx.shadowBlur = 6;
    gfx.shadowOffsetY = 2;

    if (t.kind === 'ball') {
      const gr = gfx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.3, r * 0.2, p.x, p.y, r);
      gr.addColorStop(0, '#fff9c4');
      gr.addColorStop(1, getVar('--ball') || '#eab308');
      gfx.fillStyle = gr;
      dot(p.x, p.y, r);
      gfx.restore();
      gfx.strokeStyle = 'rgba(0,0,0,0.25)';
      gfx.lineWidth = Math.max(1, r * 0.12);
      gfx.beginPath();
      gfx.arc(p.x, p.y, r * 0.7, Math.PI * 0.15, Math.PI * 0.85);
      gfx.stroke();
      return;
    }

    const color = t.team === 'a' ? (getVar('--team-a') || '#3b82f6') : (getVar('--team-b') || '#ef4444');
    const gr = gfx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, r * 0.2, p.x, p.y, r);
    gr.addColorStop(0, lighten(color, 0.35));
    gr.addColorStop(1, color);
    gfx.fillStyle = gr;
    dot(p.x, p.y, r);
    gfx.restore();

    gfx.strokeStyle = 'rgba(255,255,255,0.9)';
    gfx.lineWidth = Math.max(1.5, r * 0.1);
    gfx.beginPath();
    gfx.arc(p.x, p.y, r, 0, Math.PI * 2);
    gfx.stroke();

    gfx.fillStyle = '#fff';
    gfx.font = `700 ${Math.round(r * 1.05)}px -apple-system, sans-serif`;
    gfx.textAlign = 'center';
    gfx.textBaseline = 'middle';
    gfx.fillText(t.label, p.x, p.y + r * 0.04);
  }

  // ---------- Главный render ----------
  let preview = null; // временный line/arrow при перетаскивании

  function renderScene() {
    drawCourt();
    for (const d of state.drawings) drawDrawing(d);
    if (preview) drawDrawing(preview);
    for (const t of state.tokens) drawToken(t);
  }

  function render() {
    screenCtx.clearRect(0, 0, canvas.width, canvas.height);
    renderScene();
  }

  // ---------- Взаимодействие ----------
  let active = null;

  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function hitToken(px, py) {
    for (let i = state.tokens.length - 1; i >= 0; i--) {
      const t = state.tokens[i];
      const p = toPx(t);
      const r = tokenRadius(t) + 6;
      if ((px - p.x) ** 2 + (py - p.y) ** 2 <= r * r) return t;
    }
    return null;
  }

  function onDown(e) {
    if (active) return;
    canvas.setPointerCapture(e.pointerId);
    const pos = pointerPos(e);

    if (state.tool === 'move') {
      const t = hitToken(pos.x, pos.y);
      if (t) { active = { pointerId: e.pointerId, mode: 'drag', token: t }; haptic('light'); }
      return;
    }

    if (state.tool === 'eraser') {
      active = { pointerId: e.pointerId, mode: 'erase' };
      eraseAt(pos.x, pos.y);
      return;
    }

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
        state.drawings.push({
          type: active.mode, color: state.color,
          width: WIDTHS[state.width], from: active.from, to: active.to,
        });
      }
      preview = null;
      render();
    } else if (active.mode === 'drag') {
      haptic('light');
    }
    active = null;
  }

  function eraseAt(px, py) {
    const threshold = 14;
    for (let i = state.drawings.length - 1; i >= 0; i--) {
      if (drawingHit(state.drawings[i], px, py, threshold)) {
        state.drawings.splice(i, 1);
        haptic('rigid');
        render();
        return;
      }
    }
  }

  function drawingHit(d, px, py, thr) {
    if (d.type === 'pen') {
      if (d.points.length === 1) {
        const a = toPx(d.points[0]);
        return Math.hypot(px - a.x, py - a.y) <= thr;
      }
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
    for (const b of toolsEl.querySelectorAll('.tool')) {
      b.classList.toggle('active', b.dataset.tool === tool);
    }
  }

  // Палитра
  const paletteEl = document.getElementById('palette');
  COLORS.forEach((c) => {
    const s = document.createElement('button');
    s.className = 'swatch';
    s.style.background = c;
    s.dataset.color = c;
    if (c === state.color) s.classList.add('active');
    s.addEventListener('click', () => {
      state.color = c;
      for (const el of paletteEl.children) el.classList.toggle('active', el.dataset.color === c);
      if (state.tool === 'move' || state.tool === 'eraser') setTool('pen');
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
    haptic('select');
  });

  // ---------- Верхние действия ----------
  document.getElementById('btn-undo').addEventListener('click', () => {
    if (state.drawings.length) { state.drawings.pop(); render(); haptic('light'); }
    else toast('Нечего отменять');
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    if (!state.drawings.length) { toast('Рисунков нет'); return; }
    state.drawings = []; preview = null; render();
    haptic('medium'); toast('Рисунки очищены');
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    state.tokens = defaultTokens(); render();
    haptic('medium'); toast('Позиции сброшены');
  });

  document.getElementById('btn-share').addEventListener('click', shareImage);

  // ---------- Экспорт / поделиться ----------
  async function shareImage() {
    haptic('light');
    const blob = await exportBlob();
    if (!blob) { toast('Не удалось создать картинку'); return; }
    const file = new File([blob], 'padel-tactics.png', { type: 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Padel Tactics' }); return; }
      catch (_) { /* отменено */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'padel-tactics.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Картинка сохранена');
  }

  function exportBlob() {
    const scale = 2;
    const outW = 700, outH = 1400;
    const off = document.createElement('canvas');
    off.width = outW * scale;
    off.height = outH * scale;
    const octx = off.getContext('2d');
    octx.scale(scale, scale);

    octx.fillStyle = getVar('--bg') || '#17212b';
    octx.fillRect(0, 0, outW, outH);

    const pad = 30;
    const cw = outW - pad * 2;
    const ch = cw * 2;
    const tmpCourt = { x: pad, y: (outH - ch) / 2, w: cw, h: ch };

    return new Promise((resolve) => {
      withTarget(octx, tmpCourt, renderScene);
      off.toBlob((b) => resolve(b), 'image/png');
    });
  }

  // ---------- Утилиты ----------
  function getVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
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
