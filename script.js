'use strict';

/*
 * Dynamic Island
 * ------------------------------------------------------------
 * Presentaciones de la isla:
 *   idle      píldora vacía (o actividades ocultas con un swipe)
 *   compact   la actividad principal a los lados de la cámara
 *   expanded  la actividad abierta a pantalla ancha
 *   alert     aviso temporal del sistema (carga, silencio, AirPods, Face ID)
 *
 * Actividades (Live Activities): música, temporizador y llamada. Si hay
 * dos a la vez, la de más prioridad va en la isla y la otra en la
 * burbuja "minimal" de la derecha, como en iOS.
 *
 * La forma se anima con springs físicos (como SwiftUI): las animaciones
 * se pueden interrumpir y heredan la velocidad del gesto.
 */
(() => {
  const phone = document.querySelector('.phone');
  const island = document.getElementById('island');
  if (!phone || !island) return;

  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt = (secs) => {
    const s = Math.max(0, Math.floor(secs));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const toggle = qs('.island-toggle', island);
  const minimalEl = qs('.island-minimal');
  const announcer = qs('[data-announcer]');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const coarsePointer = window.matchMedia('(pointer: coarse)');

  let keyboardMode = false;

  /** Mensaje para lectores de pantalla. */
  function announce(text) {
    announcer.textContent = '';
    requestAnimationFrame(() => { announcer.textContent = text; });
  }

  /** Vibración en móviles (Android); en el resto no hace nada. */
  function haptic(pattern = 8) {
    if (!coarsePointer.matches) return;
    try { navigator.vibrate?.(pattern); } catch { /* sin soporte */ }
  }

  /* ============================================================
     Estado del sistema
     ============================================================ */
  const system = {
    silent: false,
    simCharging: false,   // cargador simulado desde el panel
    realCharging: false,  // cargador real (Battery API)
    level: 0.82,
    unlockTimer: 0,
  };

  /* ============================================================
     Sonido (Web Audio, sin archivos). El modo silencio lo apaga.
     ============================================================ */
  const sound = (() => {
    let ctx = null;
    function getCtx() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    function tone(freq, at, dur, vol = 0.05) {
      const c = ctx && getCtx();
      if (!c) return;
      const t = c.currentTime + at;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(c.destination);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
    return {
      /** Se llama en un gesto del usuario para que el navegador permita el audio. */
      unlock() { try { getCtx(); } catch { /* sin audio */ } },
      chime() {
        if (system.silent) return;
        [880, 1175, 1568].forEach((f, i) => tone(f, i * 0.15, 0.55));
      },
      ring() {
        if (system.silent) return;
        for (let i = 0; i < 8; i++) tone(i % 2 ? 698 : 880, i * 0.08, 0.11, 0.035);
      },
    };
  })();

  /* ============================================================
     Medidas (em; 1em = 1/80 del alto del teléfono)
     ============================================================ */
  const cssEm = (name, fallback) => {
    const v = parseFloat(getComputedStyle(phone).getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  const PILL = cssEm('--island-h', 3.46);
  const EXP_R = 4.1;       // radio de la isla abierta
  const MINIMAL_GAP = 0.55;

  const SIZES = {
    idle: { w: cssEm('--island-w', 11.7), h: PILL },
    compact: { music: 20, timer: 20, call: 20 },
    expanded: {
      music: { w: 34.4, h: 14.85 },
      timer: { w: 34.4, h: 8.6 },
      call: { w: 34.4, h: 8.2 },
    },
    alert: {
      charging: { w: 30, h: 3.9 },
      silent: { w: 21, h: PILL },
      airpods: { w: 31, h: 4.9 },
      faceid: { w: 11.7, h: 11.7, r: 3.4 },
    },
  };

  // Cada vista expandida o de alerta se dibuja con su tamaño final
  const views = new Map(qsa('[data-view]', island).map((el) => [el.dataset.view, el]));
  views.forEach((el, key) => {
    const [id, kind] = key.split(':');
    const s = id === 'alert' ? SIZES.alert[kind] : kind === 'expanded' ? SIZES.expanded[id] : null;
    if (!s) return;
    el.style.setProperty('--vw', `${s.w}em`);
    el.style.setProperty('--vh', `${s.h}em`);
  });

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

  const sp = {
    w: new Spring(SIZES.idle.w),
    h: new Spring(PILL),
    r: new Spring(PILL / 2),
    s: new Spring(1),   // escala al presionar
    tx: new Spring(0),  // desplazamiento lateral al deslizar
    mx: new Spring(SIZES.idle.w / 2 - PILL / 2), // posición de la burbuja minimal
    ms: new Spring(0),  // escala de la burbuja minimal
  };
  const springs = Object.values(sp);
  let frame = 0;
  let lastFrame = 0;

  function render() {
    const w = sp.w.value;
    const h = sp.h.value;
    const r = clamp(sp.r.value, 0, Math.min(w, h) / 2);
    const st = island.style;
    st.width = `${w.toFixed(3)}em`;
    st.height = `${h.toFixed(3)}em`;
    st.borderRadius = `${r.toFixed(3)}em`;
    const tx = sp.tx.value;
    const s = sp.s.value;
    st.transform = Math.abs(tx) < 1e-3 && Math.abs(s - 1) < 1e-4
      ? ''
      : `translateX(${tx.toFixed(3)}em) scale(${s.toFixed(4)})`;
    minimalEl.style.transform = `translateX(${sp.mx.value.toFixed(3)}em) scale(${Math.max(0, sp.ms.value).toFixed(4)})`;
  }

  function tick(now) {
    const dt = clamp((now - lastFrame) / 1000, 0, 1 / 30);
    lastFrame = now;
    // Subpasos fijos (~240 Hz): el resultado es igual a 60 o 120 fps
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
     Actividades y presentación
     ============================================================ */
  const acts = {
    music: { priority: 1, running: false, since: 0, sticky: () => false, label: () => musicLabel() },
    timer: { priority: 2, running: false, since: 0, sticky: () => timer.done, label: () => timerLabel() },
    call:  { priority: 3, running: false, since: 0, sticky: () => call.phase === 'incoming', label: () => callLabel() },
  };

  const ui = {
    mode: 'idle',
    current: null,    // actividad en la isla
    minimal: null,    // actividad en la burbuja
    expandedId: null, // actividad abierta
    hidden: false,    // ocultas con un swipe lateral
    alert: null,      // alerta del sistema en curso
  };

  const runningActs = () => Object.entries(acts)
    .filter(([, a]) => a.running)
    .sort(([, a], [, b]) => b.priority - a.priority || b.since - a.since)
    .map(([id]) => id);
  const hasHidden = () => ui.hidden && runningActs().length > 0;

  function targetSize(mode = ui.mode, id = ui.current) {
    let s;
    if (mode === 'alert') s = SIZES.alert[ui.alert];
    else if (mode === 'expanded') s = SIZES.expanded[id];
    else if (mode === 'compact') s = { w: SIZES.compact[id], h: PILL };
    else s = SIZES.idle;
    return { w: s.w, h: s.h, r: s.r ?? Math.min(s.h / 2, EXP_R) };
  }

  function motionFor(prev, next) {
    if (next === 'expanded') return [0.5, 0.72];          // abre con rebote visible
    if (next === 'alert') return [0.48, 0.7];
    if (prev === 'expanded' || prev === 'alert') return [0.44, 0.86]; // cierra más firme
    if (next === 'compact') return [0.55, 0.62];          // aparece con un "pop"
    return [0.42, 0.92];
  }

  const viewKey = () => {
    if (ui.mode === 'alert') return `alert:${ui.alert}`;
    if (ui.mode === 'expanded') return `${ui.current}:expanded`;
    if (ui.mode === 'compact') return `${ui.current}:compact`;
    return null;
  };
  const shownView = () => views.get(viewKey()) ?? null;

  /** Calcula la presentación a partir del estado y la anima. */
  function layout(velocity) {
    const list = runningActs();
    if (ui.expandedId && !acts[ui.expandedId].running) ui.expandedId = null;
    if (!list.length) ui.hidden = false;

    let mode = 'idle';
    let current = null;
    let minimal = null;
    if (ui.alert) mode = 'alert';
    else if (ui.expandedId) { mode = 'expanded'; current = ui.expandedId; }
    else if (list.length && !ui.hidden) { mode = 'compact'; current = list[0]; minimal = list[1] ?? null; }

    const prev = { mode: ui.mode, current: ui.current };
    Object.assign(ui, { mode, current, minimal });

    const size = targetSize();
    const [response, damping] = motionFor(prev.mode, mode);
    // El alto va algo desfasado del ancho: la forma se estira de forma orgánica
    const lag = mode === 'expanded' || mode === 'alert' ? 1.12 : prev.mode === 'expanded' ? 0.88 : 1;
    sp.w.configure(response, damping).target = size.w;
    sp.h.configure(response * lag, damping).target = size.h;
    sp.r.configure(response, Math.min(1, damping + 0.1)).target = size.r;
    sp.tx.configure(0.45, 0.75).target = 0;
    if (velocity) {
      if (Number.isFinite(velocity.w)) sp.w.velocity = velocity.w;
      if (Number.isFinite(velocity.h)) sp.h.velocity = velocity.h;
    }

    // La burbuja sale desde el borde derecho de la isla
    const tucked = size.w / 2 - PILL / 2;
    if (minimal) {
      minimalEl.dataset.kind = minimal;
      if (sp.ms.value < 0.05) sp.mx.hold(tucked);
      sp.mx.configure(0.55, 0.68).target = size.w / 2 + MINIMAL_GAP + PILL / 2;
      sp.ms.configure(0.5, 0.68).target = 1;
    } else {
      sp.mx.configure(0.4, 0.9).target = tucked;
      sp.ms.configure(0.32, 1).target = 0;
    }

    kick();
    applyDom(prev, size);
  }

  function applyDom(prev, size) {
    const { mode, current, minimal } = ui;
    phone.dataset.island = mode;
    if (minimal) phone.dataset.minimal = minimal;
    else delete phone.dataset.minimal;

    // La barra de estado se reparte a los lados; si la isla es muy ancha se oculta
    if (mode === 'idle' || mode === 'compact' || (mode === 'alert' && size.w < 24)) {
      phone.style.setProperty('--island-cur-w', `${size.w}em`);
      delete phone.dataset.status;
    } else {
      phone.dataset.status = 'hidden';
    }

    const shown = shownView();
    const focusWasInHiddenView = [...views.values()]
      .some((v) => v !== shown && v.contains(document.activeElement));
    views.forEach((el) => {
      const on = el === shown;
      el.classList.toggle('is-shown', on);
      el.inert = !on || !el.classList.contains('view--expanded');
    });

    const changed = prev.mode !== mode || prev.current !== current;
    if (mode === 'expanded' && keyboardMode && changed) {
      const first = qsa('[data-autofocus], button', shown).find((b) => b.offsetParent !== null);
      first?.focus({ preventScroll: true });
    } else if (focusWasInHiddenView) {
      if (keyboardMode && mode !== 'expanded') toggle.focus({ preventScroll: true });
      else document.activeElement?.blur();
    }

    toggle.setAttribute('aria-expanded', String(mode === 'expanded'));
    minimalEl.tabIndex = minimal ? 0 : -1;
    minimalEl.setAttribute('aria-hidden', String(!minimal));
    refreshLabels();
    armAutoCollapse();
  }

  const ALERT_LABELS = {
    charging: () => `Cargando, ${Math.round(system.level * 100)} %`,
    silent: () => (system.silent ? 'Modo silencio activado' : 'Timbre activado'),
    airpods: () => 'AirPods Pro conectados',
    faceid: () => 'Face ID',
  };

  function refreshLabels() {
    let label = 'Dynamic Island';
    if (ui.mode === 'alert') label = `Dynamic Island: ${ALERT_LABELS[ui.alert]()}. Cerrar aviso`;
    else if (ui.mode === 'compact') label = `${acts[ui.current].label()}. Abrir`;
    else if (hasHidden()) label = 'Dynamic Island. Mostrar actividades ocultas';
    toggle.setAttribute('aria-label', label);
    if (ui.minimal) minimalEl.setAttribute('aria-label', `${acts[ui.minimal].label()}. Abrir`);
    syncPanel();
  }

  function startActivity(id) {
    const a = acts[id];
    if (!a.running) {
      a.running = true;
      a.since = performance.now();
    }
    ui.hidden = false; // una actividad nueva vuelve a mostrar la isla
    layout();
  }

  function endActivity(id) {
    const a = acts[id];
    if (!a.running) return;
    a.running = false;
    if (ui.expandedId === id) ui.expandedId = null;
    layout();
  }

  function expand(id = ui.current, velocity) {
    if (!id || !acts[id].running) return;
    clearTimeout(alertTimer);
    ui.alert = null;
    ui.expandedId = id;
    ui.hidden = false;
    layout(velocity);
    haptic();
  }

  function collapse(velocity) {
    ui.expandedId = null;
    layout(velocity);
  }

  /* ---------- La isla abierta se recoge sola, como en iOS ---------- */
  const AUTO_COLLAPSE_MS = 7000;
  let autoTimer = 0;
  function armAutoCollapse() {
    clearTimeout(autoTimer);
    if (ui.mode !== 'expanded' || acts[ui.current].sticky()) return;
    autoTimer = setTimeout(() => {
      const busy = gesture || player.scrubbing || (keyboardMode && island.contains(document.activeElement));
      if (busy) armAutoCollapse();
      else collapse();
    }, AUTO_COLLAPSE_MS);
  }
  ['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach((type) => {
    island.addEventListener(type, () => { if (ui.mode === 'expanded') armAutoCollapse(); }, { passive: true });
  });

  /* ---------- Alertas del sistema ---------- */
  const ALERT_MS = { charging: 2600, silent: 1800, airpods: 3200, faceid: 2000 };
  let alertTimer = 0;

  function showAlert(kind) {
    clearTimeout(alertTimer);
    if (ui.alert === kind) { // reinicia las animaciones CSS de la alerta
      const el = views.get(`alert:${kind}`);
      el.classList.remove('is-shown');
      void el.offsetWidth;
    }
    ui.alert = kind;
    if (ui.expandedId && !acts[ui.expandedId].sticky()) ui.expandedId = null;
    layout();
    alertTimer = setTimeout(() => dismissAlert(), ALERT_MS[kind]);
  }

  function dismissAlert(velocity) {
    clearTimeout(alertTimer);
    if (!ui.alert) return;
    ui.alert = null;
    layout(velocity);
  }

  /* ============================================================
     Música
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

  const musicView = views.get('music:expanded');
  const meta = qs('.track-meta', musicView);
  const titleEl = qs('[data-title]', musicView);
  const artistEl = qs('[data-artist]', musicView);
  const arts = qsa('[data-art]');
  const progress = qs('.progress', musicView);
  const progressTrack = qs('.progress-track', musicView);
  const fill = qs('.progress-fill', musicView);
  const elapsedEl = qs('[data-elapsed]', musicView);
  const remainingEl = qs('[data-remaining]', musicView);
  const playBtn = qs('[data-play]', musicView);

  const player = { index: 0, elapsed: 80, playing: false, scrubbing: false };
  const track = () => tracks[player.index];
  const musicLabel = () => `${player.playing ? 'Reproduciendo' : 'En pausa'}: ${track().title}, ${track().artist}`;

  let lastSecond = -1;
  let loop = 0;
  let loopLast = 0;
  let musicEndTimer = 0;

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

  /** Si la música queda en pausa, la actividad se retira pasado un rato. */
  function scheduleMusicEnd() {
    clearTimeout(musicEndTimer);
    if (player.playing || !acts.music.running) return;
    musicEndTimer = setTimeout(() => {
      if (player.playing) return;
      if (ui.mode === 'expanded' && ui.current === 'music') scheduleMusicEnd();
      else endActivity('music');
    }, 10000);
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
      if (!acts.music.running) startActivity('music');
    }
    scheduleMusicEnd();
    refreshLabels();
    if (user) haptic(6);
  }

  function stopMusic() {
    setPlaying(false);
    endActivity('music');
  }

  function applyTrackVisuals() {
    const t = track();
    titleEl.textContent = t.title;
    artistEl.textContent = t.artist;
    arts.forEach((a) => { a.style.background = t.art; });
    island.style.setProperty('--accent', t.accent);
    island.style.setProperty('--accent-2', t.accent2);
    refreshLabels();
  }

  let swapToken = 0;
  /** Cambio de canción: sale hacia un lado y entra desde el otro. */
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
      if (token !== swapToken) { // llegó otro cambio antes: cede el paso
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
      announce(`${track().title}, ${track().artist}`);
    }
  }

  playBtn.addEventListener('click', () => setPlaying(!player.playing, { user: true }));
  qs('[data-prev]', musicView).addEventListener('click', () => changeTrack(-1));
  qs('[data-next]', musicView).addEventListener('click', () => changeTrack(1));

  /* ---------- Barra de progreso arrastrable ---------- */
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
     Temporizador
     ============================================================ */
  const timerView = views.get('timer:expanded');
  const timerEls = {
    times: qsa('[data-timer-time]'),
    rings: qsa('[data-timer-ring]'),
    label: qs('[data-timer-label]', timerView),
    toggle: qs('[data-timer-toggle]', timerView),
    cancel: qs('[data-timer-cancel]', timerView),
  };
  const timer = { total: 60, remaining: 60, endsAt: 0, paused: false, done: false, doneTimer: 0, chimeLoop: 0 };
  const timerLabel = () => {
    if (timer.done) return 'Temporizador terminado';
    return `Temporizador${timer.paused ? ' en pausa' : ''}, ${fmt(Math.ceil(timer.remaining))}`;
  };

  function renderTimer() {
    const text = fmt(timer.done ? 0 : Math.ceil(timer.remaining - 1e-6));
    timerEls.times.forEach((el) => { if (el.textContent !== text) el.textContent = text; });
    const p = timer.total ? clamp(timer.remaining / timer.total, 0, 1) : 0;
    timerEls.rings.forEach((el) => el.style.setProperty('--p', p.toFixed(4)));
    phone.dataset.timer = !acts.timer.running ? '' : timer.done ? 'done' : timer.paused ? 'paused' : 'running';
    timerEls.label.textContent = timer.done ? 'Listo' : timer.paused ? 'En pausa' : 'Temporizador';
    timerEls.toggle.setAttribute('aria-label',
      timer.done ? 'Repetir temporizador' : timer.paused ? 'Reanudar temporizador' : 'Pausar temporizador');
    timerEls.cancel.setAttribute('aria-label', timer.done ? 'Detener temporizador' : 'Cancelar temporizador');
  }

  function stopDoneAlarm() {
    clearTimeout(timer.doneTimer);
    clearInterval(timer.chimeLoop);
  }

  function startTimer(seconds = timer.total) {
    stopDoneAlarm();
    Object.assign(timer, {
      total: seconds, remaining: seconds, endsAt: Date.now() + seconds * 1000, paused: false, done: false,
    });
    startActivity('timer');
    renderTimer();
    ensureTicker();
  }

  function toggleTimer() {
    if (timer.done) {
      startTimer(timer.total);
      collapse();
      return;
    }
    if (timer.paused) {
      timer.endsAt = Date.now() + timer.remaining * 1000;
      timer.paused = false;
      ensureTicker();
    } else {
      timer.remaining = Math.max(0, (timer.endsAt - Date.now()) / 1000);
      timer.paused = true;
    }
    renderTimer();
    refreshLabels();
    haptic(6);
  }

  function cancelTimer() {
    stopDoneAlarm();
    timer.done = false;
    timer.paused = false;
    timer.remaining = timer.total;
    endActivity('timer');
    renderTimer();
  }

  function finishTimer() {
    timer.done = true;
    timer.remaining = 0;
    renderTimer();
    // No le quita la isla a una llamada entrante
    if (!(ui.expandedId === 'call' && call.phase === 'incoming')) expand('timer');
    else layout();
    sound.chime();
    timer.chimeLoop = setInterval(() => sound.chime(), 2500);
    haptic([120, 80, 120]);
    announce('Temporizador terminado');
    timer.doneTimer = setTimeout(() => { if (timer.done) cancelTimer(); }, 30000);
  }

  function tickTimer() {
    if (!acts.timer.running || timer.paused || timer.done) return;
    timer.remaining = Math.max(0, (timer.endsAt - Date.now()) / 1000);
    if (timer.remaining <= 0) finishTimer();
    else renderTimer();
  }

  timerEls.toggle.addEventListener('click', toggleTimer);
  timerEls.cancel.addEventListener('click', cancelTimer);

  /* ============================================================
     Llamada
     ============================================================ */
  const callView = views.get('call:expanded');
  const callEls = {
    duration: qs('[data-call-duration]', island),
    status: qs('[data-call-status]', callView),
    mute: qs('[data-call-mute]', callView),
    end: qs('[data-call-end]', callView),
    accept: qs('[data-call-accept]', callView),
  };
  const call = { phase: null, startedAt: 0, muted: false, ringLoop: 0, missTimer: 0, collapseTimer: 0 };
  const callDuration = () => fmt((Date.now() - call.startedAt) / 1000);
  const callLabel = () => (call.phase === 'incoming' ? 'Llamada entrante de Mamá' : `Llamada con Mamá, ${callDuration()}`);

  function renderCall() {
    phone.dataset.call = call.phase || '';
    phone.dataset.callMuted = String(call.muted);
    const dur = call.phase === 'active' ? callDuration() : '0:00';
    if (callEls.duration.textContent !== dur) callEls.duration.textContent = dur;
    const status = call.phase === 'active' ? dur : 'Llamada móvil';
    if (callEls.status.textContent !== status) callEls.status.textContent = status;
    callEls.end.setAttribute('aria-label', call.phase === 'active' ? 'Colgar' : 'Rechazar llamada');
    callEls.mute.setAttribute('aria-pressed', String(call.muted));
  }

  function stopRinging() {
    clearInterval(call.ringLoop);
    call.ringLoop = 0;
  }

  function startRinging() {
    stopRinging();
    const ringOnce = () => { sound.ring(); haptic([300, 200, 300]); };
    ringOnce();
    call.ringLoop = setInterval(ringOnce, 2400);
  }

  function incomingCall() {
    if (acts.call.running) return;
    Object.assign(call, { phase: 'incoming', muted: false });
    renderCall();
    startActivity('call');
    expand('call');
    startRinging();
    call.missTimer = setTimeout(() => {
      if (call.phase === 'incoming') endCall('Llamada perdida');
    }, 25000);
    announce('Llamada entrante de Mamá');
  }

  function acceptCall() {
    stopRinging();
    clearTimeout(call.missTimer);
    call.phase = 'active';
    call.startedAt = Date.now();
    renderCall();
    ensureTicker();
    layout();
    haptic(10);
    announce('Llamada en curso');
    call.collapseTimer = setTimeout(() => {
      if (ui.mode === 'expanded' && ui.current === 'call') collapse();
    }, 1800);
  }

  function endCall(message = 'Llamada finalizada') {
    stopRinging();
    clearTimeout(call.missTimer);
    clearTimeout(call.collapseTimer);
    call.phase = null;
    call.muted = false;
    endActivity('call');
    renderCall();
    announce(message);
  }

  callEls.accept.addEventListener('click', acceptCall);
  callEls.end.addEventListener('click', () => endCall());
  callEls.mute.addEventListener('click', () => {
    call.muted = !call.muted;
    renderCall();
    haptic(6);
  });

  /* ---------- Reloj interno para temporizador y llamada ---------- */
  let ticker = 0;
  function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      tickTimer();
      if (call.phase === 'active') renderCall();
      const needed = (acts.timer.running && !timer.paused && !timer.done) || call.phase === 'active';
      if (!needed) {
        clearInterval(ticker);
        ticker = 0;
      }
    }, 100);
  }

  /* ============================================================
     Alertas: carga, silencio, AirPods y Face ID
     ============================================================ */
  const batteryLevel = qs('.battery-level');
  const chargePct = qs('[data-charge-pct]');
  const silentLabel = qs('[data-silent-label]');
  const podsPct = qs('[data-pods-pct]');
  const podsRing = qs('[data-pods-ring] .ring-fill');

  function renderBattery() {
    const charging = system.simCharging || system.realCharging;
    batteryLevel?.setAttribute('width', (20 * clamp(system.level, 0.06, 1)).toFixed(2));
    phone.dataset.charging = String(charging);
    phone.dataset.lowBattery = String(system.level <= 0.2 && !charging);
    chargePct.textContent = `${Math.round(system.level * 100)} %`;
  }

  function setCharger(on) {
    system.simCharging = on;
    renderBattery();
    if (on) {
      showAlert('charging');
      announce(ALERT_LABELS.charging());
    }
    haptic(on ? 20 : 8);
    syncPanel();
  }

  function toggleSilent() {
    system.silent = !system.silent;
    phone.dataset.silent = String(system.silent);
    silentLabel.textContent = system.silent ? 'Silencio' : 'Timbre';
    showAlert('silent');
    haptic(system.silent ? [30, 60, 30] : 20);
    announce(ALERT_LABELS.silent());
  }

  function connectAirPods() {
    const pct = 70 + Math.round(Math.random() * 30);
    podsPct.textContent = String(pct);
    // Reinicia el anillo para que vuelva a llenarse
    podsRing.style.transition = 'none';
    podsRing.style.strokeDashoffset = '100';
    void podsRing.getBoundingClientRect();
    podsRing.style.transition = '';
    showAlert('airpods');
    requestAnimationFrame(() => { podsRing.style.strokeDashoffset = String(100 - pct); });
    haptic(12);
    announce(`AirPods Pro conectados, batería ${pct} %`);
  }

  function faceId() {
    showAlert('faceid');
    haptic(10);
    clearTimeout(system.unlockTimer);
    phone.dataset.unlocked = 'false';
    system.unlockTimer = setTimeout(() => {
      phone.dataset.unlocked = 'true';
      haptic([15, 40, 15]);
      announce('Desbloqueado con Face ID');
      system.unlockTimer = setTimeout(() => { phone.dataset.unlocked = 'false'; }, 5000);
    }, 1150);
  }

  /* ============================================================
     Gestos sobre la isla
     - Toque: abre la actividad (o recupera las ocultas)
     - Deslizar a un lado en compacta: oculta las actividades
     - Deslizar hacia abajo en compacta: abre siguiendo el dedo
     - Deslizar hacia arriba en abierta o en una alerta: cierra
     Al soltar, la velocidad del dedo pasa al spring.
     ============================================================ */
  let gesture = null;
  let suppressClickUntil = 0;
  const rubber = (x, dim) => dim * (1 - 1 / ((x * 0.55) / dim + 1)); // rubber-band de iOS

  function press(down) {
    sp.s.configure(down ? 0.25 : 0.45, down ? 0.9 : 0.5).target = down ? 0.94 : 1;
    kick();
  }

  function velocityOf(g, now) {
    const s = g.samples;
    if (s.length < 2) return [0, 0];
    const a = s[0];
    const b = s[s.length - 1];
    const dt = b[0] - a[0];
    if (dt <= 0 || now - b[0] > 80) return [0, 0]; // el dedo se quedó quieto antes de soltar
    const k = 1000 / dt / g.unit; // px/ms → em/s
    return [(b[1] - a[1]) * k, (b[2] - a[2]) * k];
  }

  function applyDrag(g) {
    const b = g.base;
    const view = shownView();

    if (g.axis === 'x') {
      const sign = Math.sign(g.dx) || 1;
      const ax = Math.abs(g.dx);
      if (g.from === 'compact') {
        const room = b.w - SIZES.idle.w;
        const pull = ax * 0.6;
        sp.w.hold(b.w - Math.min(pull, room) - rubber(Math.max(0, pull - room), 1));
        sp.tx.hold(sign * rubber(ax, 4));
        if (view) view.style.opacity = String(clamp(1 - ax / 4, 0, 1));
      } else if (g.from === 'idle' && hasHidden()) {
        sp.w.hold(b.w + rubber(ax, 6));
        sp.tx.hold(sign * rubber(ax, 3));
      } else {
        sp.tx.hold(sign * rubber(ax, 1.5));
      }
      render();
      return;
    }

    const dy = g.dy;
    if (g.from === 'expanded') {
      const c = { w: SIZES.compact[g.current], h: PILL, r: PILL / 2 };
      if (dy < 0) {
        const travel = b.h - c.h;
        const up = -dy;
        const f = clamp(up / travel, 0, 1);
        sp.h.hold(b.h - Math.min(up, travel) - rubber(Math.max(0, up - travel), 2));
        sp.w.hold(b.w + (c.w - b.w) * f * 0.6);
        sp.r.hold(b.r + (c.r - b.r) * f);
        if (view) view.style.opacity = String(clamp(1 - f * 1.6, 0, 1));
      } else {
        const d = rubber(dy, 6);
        sp.h.hold(b.h + d);
        sp.w.hold(b.w + d * 0.12);
      }
    } else if (g.from === 'compact' && dy > 0) {
      const d = rubber(dy, 9);
      sp.h.hold(b.h + d * 0.9);
      sp.w.hold(b.w + d * 0.7);
      sp.r.hold(b.r + d * 0.3);
    } else if (g.from === 'alert') {
      const d = dy < 0 ? -rubber(-dy, 3) : rubber(dy, 2);
      sp.h.hold(Math.max(PILL * 0.8, b.h + d));
      sp.w.hold(b.w + d * 0.4);
      if (view && dy < 0) view.style.opacity = String(clamp(1 + dy / 3, 0, 1));
    } else {
      const d = dy < 0 ? -rubber(-dy, 2) : rubber(dy, 2.5);
      sp.h.hold(b.h + d * 0.5);
      sp.w.hold(b.w - Math.abs(d) * 0.4 * Math.sign(-d));
      sp.r.hold((b.h + d * 0.5) / 2);
    }
    render();
  }

  /** Toque sin arrastre (o Enter/Espacio sobre la isla). */
  function tap() {
    if (ui.mode === 'compact') expand(ui.current);
    else if (ui.mode === 'alert') dismissAlert();
    else if (ui.mode === 'idle' && hasHidden()) {
      ui.hidden = false;
      layout();
      haptic();
    }
  }

  island.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0 || gesture) return;
    if (e.target.closest('button:not(.island-toggle), .progress')) return; // controles con su propio gesto
    sound.unlock();
    gesture = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      from: ui.mode,
      current: ui.current,
      base: targetSize(),
      axis: null,
      dx: 0,
      dy: 0,
      unit: parseFloat(getComputedStyle(island).fontSize) || 8,
      samples: [[e.timeStamp, e.clientX, e.clientY]],
    };
    try { island.setPointerCapture(e.pointerId); } catch { /* puntero ya liberado */ }
    if (ui.mode !== 'expanded') press(true);
  });

  island.addEventListener('pointermove', (e) => {
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.axis) {
      if (Math.hypot(dx, dy) < 6) return;
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      press(false);
      island.classList.add('is-dragging');
    }
    g.samples.push([e.timeStamp, e.clientX, e.clientY]);
    while (g.samples.length > 2 && e.timeStamp - g.samples[0][0] > 100) g.samples.shift();
    g.dx = dx / g.unit;
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
    views.forEach((v) => { v.style.opacity = ''; });

    if (!g.axis) {
      if (e.type === 'pointerup') tap();
      return;
    }

    const [vx, vy] = velocityOf(g, e.timeStamp);

    if (g.axis === 'x') {
      if (g.from === 'compact' && (Math.abs(g.dx) > 2.4 || Math.abs(vx) > 18)) {
        ui.hidden = true;
        layout({ w: -Math.abs(vx) * 0.2 });
        haptic();
        announce('Actividades ocultas. Toca la isla para mostrarlas.');
      } else if (g.from === 'idle' && hasHidden() && (Math.abs(g.dx) > 1.6 || Math.abs(vx) > 14)) {
        ui.hidden = false;
        layout({ w: Math.abs(vx) * 0.2 });
        haptic();
      } else {
        layout();
      }
      sp.tx.velocity = vx * 0.3;
      kick();
      return;
    }

    if (g.from === 'expanded') {
      if (g.dy < -2.2 || vy < -14) collapse({ h: vy, w: vy * 0.4 });
      else layout({ h: vy * 0.5 });
    } else if (g.from === 'compact') {
      if (g.dy > 1.6 || vy > 12) expand(g.current, { h: Math.max(0, vy * 0.5), w: Math.max(0, vy * 0.3) });
      else layout({ h: vy * 0.3, w: vy * 0.2 });
    } else if (g.from === 'alert') {
      if (g.dy < -1.2 || vy < -10) dismissAlert({ h: vy * 0.5 });
      else layout({ h: vy * 0.3 });
    } else {
      layout({ h: vy * 0.3 });
    }
  }
  island.addEventListener('pointerup', release);
  island.addEventListener('pointercancel', release);

  // El botón invisible da soporte de teclado (Enter / Espacio)
  toggle.addEventListener('click', () => {
    if (performance.now() < suppressClickUntil) return;
    if (ui.mode === 'expanded') collapse();
    else tap();
  });

  minimalEl.addEventListener('click', () => {
    if (ui.minimal) expand(ui.minimal);
  });

  // Tocar fuera cierra la isla abierta
  document.addEventListener('pointerdown', (e) => {
    keyboardMode = false;
    if (ui.mode === 'expanded' && !island.contains(e.target) && !minimalEl.contains(e.target)) collapse();
  }, true);

  document.addEventListener('keydown', (e) => {
    keyboardMode = true;
    if (e.key !== 'Escape') return;
    if (ui.mode === 'expanded') { e.preventDefault(); collapse(); }
    else if (ui.mode === 'alert') { e.preventDefault(); dismissAlert(); }
  });

  // Con teclado, salir con Tab de la isla también la cierra
  island.addEventListener('focusout', (e) => {
    if (ui.mode === 'expanded' && keyboardMode && e.relatedTarget && !island.contains(e.relatedTarget)) collapse();
  });

  /* ============================================================
     Panel de actividades y botones físicos
     ============================================================ */
  const demoBtns = Object.fromEntries(qsa('[data-demo]').map((b) => [b.dataset.demo, b]));
  const demoActions = {
    music: () => (acts.music.running ? stopMusic() : setPlaying(true, { user: true })),
    timer: () => (acts.timer.running ? cancelTimer() : startTimer(60)),
    call: () => (acts.call.running ? endCall() : incomingCall()),
    charge: () => setCharger(!system.simCharging),
    silent: toggleSilent,
    airpods: connectAirPods,
    faceid: faceId,
  };
  Object.entries(demoBtns).forEach(([key, btn]) => {
    btn.addEventListener('click', () => {
      sound.unlock();
      demoActions[key]?.();
    });
  });

  function syncPanel() {
    const pressed = {
      music: acts.music.running,
      timer: acts.timer.running,
      call: acts.call.running,
      charge: system.simCharging,
      silent: system.silent,
    };
    Object.entries(pressed).forEach(([key, on]) => demoBtns[key]?.setAttribute('aria-pressed', String(on)));
  }

  qs('[data-hw="action"]')?.addEventListener('click', () => { sound.unlock(); toggleSilent(); });
  qs('[data-hw="side"]')?.addEventListener('click', faceId);

  /* ============================================================
     Reloj, fecha y batería real
     ============================================================ */
  const timeEls = qsa('[data-time]');
  const dateEl = qs('[data-date]');
  const timeFmt = new Intl.DateTimeFormat('es', { hour: 'numeric', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long' });

  function tickClock() {
    const now = new Date();
    const time = timeFmt.format(now);
    timeEls.forEach((el) => { el.textContent = time; });
    const date = dateFmt.format(now);
    if (dateEl) dateEl.textContent = date.charAt(0).toUpperCase() + date.slice(1);
    setTimeout(tickClock, 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 30);
  }

  if (typeof navigator.getBattery === 'function') {
    navigator.getBattery().then((b) => {
      const update = (fromEvent) => {
        const was = system.realCharging;
        system.level = b.level;
        system.realCharging = b.charging;
        renderBattery();
        // Si conectas el cargador de verdad, la isla también lo muestra
        if (fromEvent && b.charging && !was && !system.simCharging) showAlert('charging');
      };
      update(false);
      b.addEventListener('levelchange', () => update(false));
      b.addEventListener('chargingchange', () => update(true));
    }).catch(() => { /* sin acceso a la batería */ });
  }

  /* ============================================================
     Pantalla de bloqueo y tema
     ============================================================ */
  qsa('.lock-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.hasAttribute('aria-pressed')) {
        btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'));
      }
      haptic(10);
    });
  });

  const THEME_KEY = 'dynamic-island:theme';
  try {
    const saved = localStorage.getItem(THEME_KEY);
    const radio = saved && document.getElementById(saved);
    if (radio && radio.name === 'theme') radio.checked = true;
  } catch { /* almacenamiento no disponible */ }
  qsa('input[name="theme"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      try { localStorage.setItem(THEME_KEY, radio.id); } catch { /* ignorar */ }
    });
  });

  /* ============================================================
     Arranque: el teléfono entra y, al terminar, suena la música
     ============================================================ */
  progress.setAttribute('aria-valuemax', String(track().duration));
  applyTrackVisuals();
  renderProgress();
  renderTimer();
  renderCall();
  renderBattery();
  render();
  layout();
  tickClock();
  setTimeout(() => setPlaying(true), reduceMotion.matches ? 0 : 950);
})();
