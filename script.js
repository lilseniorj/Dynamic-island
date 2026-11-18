'use strict';

/*
 * Dynamic Island
 * ------------------------------------------------------------
 * Estados:  idle (píldora vacía) → compact (actividad en curso) → expanded
 * La forma de la isla se anima con springs físicos (como SwiftUI), no con
 * transiciones CSS: así las animaciones se pueden interrumpir a mitad de
 * camino y heredan la velocidad del gesto, que es lo que las hace sentir nativas.
 */
(() => {
  const phone = document.querySelector('.phone');
  const island = document.getElementById('island');
  if (!phone || !island) return;

  const $ = (sel, root = island) => root.querySelector(sel);
  const toggle = $('.island-toggle');
  const expandedView = $('#island-expanded');
  const meta = $('.track-meta');
  const titleEl = $('[data-title]');
  const artistEl = $('[data-artist]');
  const arts = [...island.querySelectorAll('[data-art]')];
  const progress = $('.progress');
  const progressTrack = $('.progress-track');
  const fill = $('.progress-fill');
  const elapsedEl = $('[data-elapsed]');
  const remainingEl = $('[data-remaining]');
  const playBtn = $('[data-play]');
  const prevBtn = $('[data-prev]');
  const nextBtn = $('[data-next]');
  const announcer = document.querySelector('[data-announcer]');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const coarsePointer = window.matchMedia('(pointer: coarse)');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** Vibración corta en móviles (Android); en el resto no hace nada. */
  function haptic(ms = 8) {
    if (!coarsePointer.matches) return;
    try { navigator.vibrate?.(ms); } catch { /* sin soporte */ }
  }

  /* ============================================================
     Medidas (en em, leídas de las variables CSS de .phone)
     ============================================================ */
  const cssEm = (name, fallback) => {
    const v = parseFloat(getComputedStyle(phone).getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  const pillH = cssEm('--island-h', 3.46);
  const SIZE = {
    idle:     { w: cssEm('--island-w', 11.7), h: pillH, r: pillH / 2 },
    compact:  { w: cssEm('--compact-w', 20),  h: pillH, r: pillH / 2 },
    expanded: { w: cssEm('--exp-w', 34.4),    h: cssEm('--exp-h', 14.85), r: cssEm('--exp-r', 4.1) },
  };

  /* ============================================================
     Spring físico
     response = duración percibida (s); damping = 1 sin rebote, <1 rebota
     ============================================================ */
  class Spring {
    constructor(value) {
      this.value = value;
      this.target = value;
      this.velocity = 0;
      this.configure(0.5, 0.8);
    }
    configure(response, damping) {
      const omega = (2 * Math.PI) / response;
      this.stiffness = omega * omega;
      this.damping = 2 * damping * omega;
      return this;
    }
    step(dt) {
      const accel = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
      this.velocity += accel * dt;
      this.value += this.velocity * dt;
    }
    get settled() {
      return Math.abs(this.velocity) < 1e-3 && Math.abs(this.value - this.target) < 1e-3;
    }
    snap() { this.value = this.target; this.velocity = 0; }
    hold(v) { this.value = this.target = v; this.velocity = 0; }
  }

  const spring = {
    w: new Spring(SIZE.idle.w),
    h: new Spring(SIZE.idle.h),
    r: new Spring(SIZE.idle.r),
    s: new Spring(1), // escala al presionar
  };
  const springs = Object.values(spring);
  let frame = 0;
  let lastFrame = 0;

  function render() {
    const w = spring.w.value;
    const h = spring.h.value;
    const r = clamp(spring.r.value, 0, Math.min(w, h) / 2);
    const s = spring.s.value;
    const st = island.style;
    st.width = `${w.toFixed(3)}em`;
    st.height = `${h.toFixed(3)}em`;
    st.borderRadius = `${r.toFixed(3)}em`;
    st.transform = Math.abs(s - 1) < 1e-4 ? '' : `scale(${s.toFixed(4)})`;
  }

  function tick(now) {
    const dt = clamp((now - lastFrame) / 1000, 0, 1 / 30);
    lastFrame = now;
    // Subpasos fijos (~240 Hz) para que el resultado sea igual a 60 o 120 fps
    const steps = Math.max(1, Math.ceil(dt * 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) for (const s of springs) s.step(h);

    const done = springs.every((s) => s.settled);
    if (done) springs.forEach((s) => s.snap());
    render();
    frame = done ? 0 : requestAnimationFrame(tick);
  }

  function kick() {
    if (reduceMotion.matches) {
      springs.forEach((s) => s.snap());
      render();
      return;
    }
    if (!frame) {
      lastFrame = performance.now();
      frame = requestAnimationFrame(tick);
    }
  }

  /* ============================================================
     Máquina de estados de la isla
     ============================================================ */
  const MOTION = {
    open:   [0.5, 0.72],  // expandir: rebote visible
    close:  [0.44, 0.86], // contraer: más firme
    appear: [0.55, 0.62], // aparece una actividad: "pop"
    vanish: [0.42, 0.92], // termina la actividad
  };

  let state = 'idle';
  let activity = false; // ¿hay una actividad (música) en la isla?
  let keyboardMode = false;
  let idleTimer = 0;

  function setState(next, velocity) {
    const prev = state;
    const [response, damping] =
      next === 'expanded' ? MOTION.open
      : prev === 'expanded' ? MOTION.close
      : next === 'compact' ? MOTION.appear
      : MOTION.vanish;
    // El alto va un poco desfasado del ancho: la forma se "estira" de forma orgánica
    const heightLag = next === 'expanded' ? 1.12 : prev === 'expanded' ? 0.88 : 1;
    const t = SIZE[next];

    spring.w.configure(response, damping).target = t.w;
    spring.h.configure(response * heightLag, damping).target = t.h;
    spring.r.configure(response, Math.min(1, damping + 0.1)).target = t.r;
    if (velocity) {
      if (Number.isFinite(velocity.w)) spring.w.velocity = velocity.w;
      if (Number.isFinite(velocity.h)) spring.h.velocity = velocity.h;
    }
    kick();

    if (prev === next) return;
    state = next;

    // Foco: se resuelve antes de volver inert la vista expandida
    const focusInside = expandedView.contains(document.activeElement);
    island.dataset.state = next;
    phone.dataset.island = next;
    toggle.setAttribute('aria-expanded', String(next === 'expanded'));
    expandedView.inert = next !== 'expanded';

    if (next === 'expanded' && keyboardMode) {
      playBtn.focus({ preventScroll: true });
    } else if (prev === 'expanded' && focusInside) {
      if (keyboardMode) toggle.focus({ preventScroll: true });
      else document.activeElement.blur();
    }

    updateLabel();
    scheduleIdle();
  }

  function expand(velocity) {
    activity = true;
    setState('expanded', velocity);
    haptic();
  }

  function collapse(velocity) {
    setState(activity ? 'compact' : 'idle', velocity);
  }

  /** Si la música queda en pausa con la isla cerrada, la actividad se retira. */
  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (player.playing || state === 'expanded' || !activity) return;
    idleTimer = setTimeout(() => {
      activity = false;
      setState('idle');
    }, 6000);
  }

  function updateLabel() {
    const t = track();
    const label = activity
      ? `${player.playing ? 'Reproduciendo' : 'En pausa'}: ${t.title}, ${t.artist}. Abrir controles`
      : 'Dynamic Island. Abrir reproductor';
    toggle.setAttribute('aria-label', label);
  }

  /* ============================================================
     Reproductor
     ============================================================ */
  const tracks = [
    {
      title: 'Now Playing', artist: 'LilSeniorJ', duration: 188,
      art: 'radial-gradient(circle at 55% 40%, #25258f, #c91a91 68%, #f6b6ff)',
      accent: '#b45cff', accent2: '#f0c8ff',
    },
    {
      title: 'Medianoche en Neón', artist: 'LilSeniorJ', duration: 214,
      art: 'linear-gradient(140deg, #0f2027, #2c5364 45%, #00ffa3)',
      accent: '#1fd99a', accent2: '#c9ffe9',
    },
    {
      title: 'Isla Dinámica', artist: 'LilSeniorJ', duration: 167,
      art: 'radial-gradient(circle at 30% 30%, #ffd36e, #ff6a3d 50%, #6a0d2b)',
      accent: '#ff7a3d', accent2: '#ffe0b8',
    },
    {
      title: 'Sin Señal', artist: 'LilSeniorJ', duration: 201,
      art: 'conic-gradient(from 210deg at 60% 40%, #1b1b3a, #4b6cff, #9ad0ff, #1b1b3a)',
      accent: '#5f7dff', accent2: '#d6e0ff',
    },
  ];

  const player = { index: 0, elapsed: 80, playing: false, scrubbing: false };
  const track = () => tracks[player.index];
  const fmt = (secs) => {
    const s = Math.max(0, Math.floor(secs));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  let lastSecond = -1;
  let loop = 0;
  let loopLast = 0;

  function renderProgress() {
    const t = track();
    const p = clamp(player.elapsed / t.duration, 0, 1);
    fill.style.transform = `scaleX(${p.toFixed(5)})`;

    const sec = Math.floor(player.elapsed);
    if (sec === lastSecond) return;
    lastSecond = sec;
    elapsedEl.textContent = fmt(sec);
    remainingEl.textContent = `-${fmt(t.duration - sec)}`;
    progress.setAttribute('aria-valuenow', String(sec));
    progress.setAttribute('aria-valuetext', `${fmt(sec)} de ${fmt(t.duration)}`);
  }

  function playerTick(now) {
    const dt = Math.max(0, (now - loopLast) / 1000);
    loopLast = now;
    if (player.playing && !player.scrubbing) {
      player.elapsed += dt;
      const over = player.elapsed - track().duration;
      if (over >= 0) {
        changeTrack(1, { auto: true });
        player.elapsed = Math.min(over, track().duration - 1);
      }
    }
    renderProgress();
    loop = player.playing ? requestAnimationFrame(playerTick) : 0;
  }

  function setPlaying(on, { user = false } = {}) {
    player.playing = on;
    phone.dataset.playing = String(on);
    playBtn.setAttribute('aria-label', on ? 'Pausar' : 'Reproducir');
    if (on) {
      if (!loop) {
        loopLast = performance.now();
        loop = requestAnimationFrame(playerTick);
      }
      if (!activity) {
        activity = true;
        if (state === 'idle') setState('compact');
      }
    }
    updateLabel();
    scheduleIdle();
    if (user) haptic(6);
  }

  function applyTrackVisuals() {
    const t = track();
    titleEl.textContent = t.title;
    artistEl.textContent = t.artist;
    arts.forEach((a) => { a.style.background = t.art; });
    island.style.setProperty('--accent', t.accent);
    island.style.setProperty('--accent-2', t.accent2);
    updateLabel();
  }

  let swapToken = 0;

  /** Cambio de canción: sale hacia un lado, entra desde el otro. */
  function swapVisuals(dir) {
    const token = ++swapToken;
    if (reduceMotion.matches || typeof meta.animate !== 'function') {
      applyTrackVisuals();
      return;
    }
    const shift = dir * 0.9;
    const outOpts = { duration: 150, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' };
    const outs = [
      meta.animate(
        [{ opacity: 1, transform: 'none', filter: 'blur(0)' },
         { opacity: 0, transform: `translateX(${-shift}em)`, filter: 'blur(.12em)' }],
        outOpts,
      ),
      ...arts.map((a) => a.animate(
        [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.82)' }],
        outOpts,
      )),
    ];

    outs[0].finished.then(() => {
      if (token !== swapToken) { // otro cambio llegó antes: cede el paso
        outs.forEach((a) => a.cancel());
        return;
      }
      applyTrackVisuals();
      const inOpts = { duration: 380, easing: 'cubic-bezier(.16, 1, .3, 1)' };
      meta.animate(
        [{ opacity: 0, transform: `translateX(${shift}em)`, filter: 'blur(.12em)' },
         { opacity: 1, transform: 'none', filter: 'blur(0)' }],
        inOpts,
      );
      arts.forEach((a) => a.animate(
        [{ opacity: 0, transform: 'scale(.82)' }, { opacity: 1, transform: 'scale(1)' }],
        inOpts,
      ));
      outs.forEach((a) => a.cancel());
    }).catch(() => { /* animación cancelada */ });
  }

  function changeTrack(dir, { auto = false } = {}) {
    // Como en iOS: "anterior" pasados 3 s reinicia la canción actual
    if (dir < 0 && !auto && player.elapsed > 3) {
      player.elapsed = 0;
      lastSecond = -1;
      renderProgress();
      haptic(6);
      return;
    }
    player.index = (player.index + dir + tracks.length) % tracks.length;
    player.elapsed = 0;
    lastSecond = -1;
    progress.setAttribute('aria-valuemax', String(track().duration));
    renderProgress();
    swapVisuals(dir);
    if (!auto) {
      haptic(6);
      announcer.textContent = `${track().title}, ${track().artist}`;
    }
  }

  playBtn.addEventListener('click', () => setPlaying(!player.playing, { user: true }));
  prevBtn.addEventListener('click', () => changeTrack(-1));
  nextBtn.addEventListener('click', () => changeTrack(1));

  /* ---------- Arrastrar la barra de progreso ---------- */
  function seek(clientX) {
    const rect = progressTrack.getBoundingClientRect();
    const p = clamp((clientX - rect.left) / rect.width, 0, 1);
    player.elapsed = Math.min(p * track().duration, track().duration - 0.01);
    renderProgress();
  }
  function endScrub() {
    if (!player.scrubbing) return;
    player.scrubbing = false;
    island.classList.remove('is-scrubbing');
  }
  progress.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { progress.setPointerCapture(e.pointerId); } catch { /* puntero ya liberado */ }
    player.scrubbing = true;
    island.classList.add('is-scrubbing');
    seek(e.clientX);
  });
  progress.addEventListener('pointermove', (e) => { if (player.scrubbing) seek(e.clientX); });
  progress.addEventListener('pointerup', endScrub);
  progress.addEventListener('pointercancel', endScrub);
  progress.addEventListener('lostpointercapture', endScrub);
  progress.addEventListener('keydown', (e) => {
    const steps = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 15, PageDown: -15 };
    const d = track().duration;
    let next;
    if (e.key in steps) next = player.elapsed + steps[e.key];
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = d - 1;
    else return;
    e.preventDefault();
    player.elapsed = clamp(next, 0, d - 1);
    renderProgress();
  });

  /* ============================================================
     Gestos sobre la isla
     - Toque en idle/compact → expandir (con "squish" al presionar)
     - Arrastrar hacia abajo en compact → abre siguiendo el dedo
     - Arrastrar hacia arriba en expanded → cierra siguiendo el dedo
     Al soltar, la velocidad del dedo pasa al spring.
     ============================================================ */
  let gesture = null;
  let suppressClickUntil = 0;
  const rubber = (x, dim) => dim * (1 - 1 / ((x * 0.55) / dim + 1)); // fórmula de rubber-band de iOS

  function press(down) {
    spring.s.configure(down ? 0.25 : 0.45, down ? 0.9 : 0.5).target = down ? 0.94 : 1;
    kick();
  }

  function velocityOf(g, now) {
    const s = g.samples;
    if (s.length < 2) return 0;
    const [t0, y0] = s[0];
    const [t1, y1] = s[s.length - 1];
    if (t1 - t0 <= 0 || now - t1 > 80) return 0; // dedo quieto antes de soltar
    return (((y1 - y0) / (t1 - t0)) * 1000) / g.unit; // em/s
  }

  function applyDrag(g) {
    const b = g.base;
    const dy = g.dy;
    if (g.from === 'expanded') {
      const c = SIZE.compact;
      if (dy < 0) {
        const travel = b.h - c.h;
        const up = -dy;
        const f = clamp(up / travel, 0, 1);
        spring.h.hold(b.h - Math.min(up, travel) - rubber(Math.max(0, up - travel), 2));
        spring.w.hold(b.w + (c.w - b.w) * f * 0.6);
        spring.r.hold(b.r + (c.r - b.r) * f);
        expandedView.style.opacity = String(clamp(1 - f * 1.6, 0, 1));
      } else {
        const d = rubber(dy, 6);
        spring.h.hold(b.h + d);
        spring.w.hold(b.w + d * 0.12);
        spring.r.hold(b.r);
      }
    } else if (dy > 0) {
      const d = rubber(dy, 9);
      spring.h.hold(b.h + d * 0.9);
      spring.w.hold(b.w + d * 0.7);
      spring.r.hold(b.r + d * 0.3);
    } else {
      const d = rubber(-dy, 3);
      spring.h.hold(b.h - d * 0.4);
      spring.w.hold(b.w - d);
      spring.r.hold((b.h - d * 0.4) / 2);
    }
    render();
  }

  island.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0 || gesture) return;
    if (e.target.closest('.ctrl, .progress')) return; // los controles tienen sus propios gestos
    gesture = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      from: state,
      base: SIZE[state],
      dragging: false,
      dy: 0,
      unit: parseFloat(getComputedStyle(island).fontSize) || 8,
      samples: [[e.timeStamp, e.clientY]],
    };
    try { island.setPointerCapture(e.pointerId); } catch { /* puntero ya liberado */ }
    if (state !== 'expanded') press(true);
  });

  island.addEventListener('pointermove', (e) => {
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.dragging) {
      if (Math.hypot(dx, dy) < 6) return;
      g.dragging = true;
      press(false);
      island.classList.add('is-dragging');
    }
    g.samples.push([e.timeStamp, e.clientY]);
    while (g.samples.length > 2 && e.timeStamp - g.samples[0][0] > 100) g.samples.shift();
    g.dy = dy / g.unit;
    applyDrag(g);
  });

  function release(e) {
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    gesture = null;
    island.classList.remove('is-dragging');
    if (island.hasPointerCapture(e.pointerId)) island.releasePointerCapture(e.pointerId);
    press(false);
    suppressClickUntil = performance.now() + 400;

    if (!g.dragging) {
      if (e.type === 'pointerup' && g.from !== 'expanded') expand();
      return;
    }

    const vy = velocityOf(g, e.timeStamp);
    expandedView.style.opacity = '';
    if (g.from === 'expanded') {
      if (g.dy < -2.2 || vy < -14) collapse({ h: vy, w: vy * 0.4 });
      else setState('expanded', { h: vy * 0.5, w: 0 });
    } else if (g.dy > 1.6 || vy > 12) {
      expand({ h: Math.max(0, vy * 0.5), w: Math.max(0, vy * 0.3) });
    } else {
      setState(g.from, { h: vy * 0.3, w: vy * 0.2 });
    }
  }
  island.addEventListener('pointerup', release);
  island.addEventListener('pointercancel', release);

  // El botón invisible da soporte de teclado (Enter / Espacio)
  toggle.addEventListener('click', () => {
    if (performance.now() < suppressClickUntil) return;
    if (state === 'expanded') collapse(); else expand();
  });

  // Tocar fuera cierra la isla
  document.addEventListener('pointerdown', (e) => {
    keyboardMode = false;
    if (state === 'expanded' && !island.contains(e.target)) collapse();
  }, true);

  document.addEventListener('keydown', (e) => {
    keyboardMode = true;
    if (e.key === 'Escape' && state === 'expanded') {
      e.preventDefault();
      collapse();
    }
  });

  // Con teclado, salir con Tab de la isla también la cierra
  island.addEventListener('focusout', (e) => {
    if (state === 'expanded' && keyboardMode && e.relatedTarget && !island.contains(e.relatedTarget)) {
      collapse();
    }
  });

  /* ============================================================
     Reloj, fecha y batería
     ============================================================ */
  const timeEls = document.querySelectorAll('[data-time]');
  const dateEl = document.querySelector('[data-date]');
  const timeFmt = new Intl.DateTimeFormat('es', { hour: 'numeric', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long' });

  function tickClock() {
    const now = new Date();
    const time = timeFmt.format(now);
    timeEls.forEach((el) => { el.textContent = time; });
    const date = dateFmt.format(now);
    if (dateEl) dateEl.textContent = date.charAt(0).toUpperCase() + date.slice(1);
    // Se re-agenda justo al cambiar de minuto
    setTimeout(tickClock, 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 30);
  }

  const batteryLevel = document.querySelector('.battery-level');
  function setBattery(level, charging) {
    batteryLevel?.setAttribute('width', (20 * clamp(level, 0.06, 1)).toFixed(2));
    phone.dataset.charging = String(charging);
    phone.dataset.lowBattery = String(level <= 0.2 && !charging);
  }
  if (typeof navigator.getBattery === 'function') {
    navigator.getBattery().then((b) => {
      const update = () => setBattery(b.level, b.charging);
      update();
      b.addEventListener('levelchange', update);
      b.addEventListener('chargingchange', update);
    }).catch(() => { /* sin acceso a la batería */ });
  }

  /* ============================================================
     Botones de la pantalla de bloqueo
     ============================================================ */
  document.querySelectorAll('.lock-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.hasAttribute('aria-pressed')) {
        btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'));
      }
      haptic(10);
    });
  });

  /* ============================================================
     Recordar el color elegido
     ============================================================ */
  const THEME_KEY = 'dynamic-island:theme';
  try {
    const saved = localStorage.getItem(THEME_KEY);
    const radio = saved && document.getElementById(saved);
    if (radio && radio.name === 'theme') radio.checked = true;
  } catch { /* almacenamiento no disponible */ }
  document.querySelectorAll('input[name="theme"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      try { localStorage.setItem(THEME_KEY, radio.id); } catch { /* ignorar */ }
    });
  });

  /* ============================================================
     Arranque: el teléfono entra y, al terminar, empieza la música
     y la actividad aparece en la isla.
     ============================================================ */
  progress.setAttribute('aria-valuemax', String(track().duration));
  applyTrackVisuals();
  renderProgress();
  render();
  tickClock();
  setTimeout(() => setPlaying(true), reduceMotion.matches ? 0 : 950);
})();
