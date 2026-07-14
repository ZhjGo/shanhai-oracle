/* ============================================================================
   山海神谕 — card lighting + tilt + draw choreography
   Ported from Tarot Sanctuary WebGL2 PBR lighting:
   1. Overlays the card <img> with a transparent WebGL2 canvas. The pointer
      drives a warm candle-gold key light over normal / roughness / height
      maps, with per-pixel height parallax. The card back is a second lit
      layer sitting on the reverse of the same 3D plane.
   2. The card mount rotates subtly in 3D: idle sway + tilt toward pointer.
   3. Draw flies the old card off top-left while the new card rises from
      bottom center, back showing, and flips face-up as it settles.
   ========================================================================== */
(function () {
  'use strict';

  const hero = document.querySelector('.hero');
  const stage = document.querySelector('.card-stage');
  const mover = document.getElementById('cardMover');
  const tilt = document.getElementById('cardTilt');
  const shadow = document.getElementById('cardShadow');
  const obj = tilt && tilt.querySelector('.card-obj');
  const img = obj && obj.querySelector('img');
  const backMount = tilt && tilt.querySelector('.card-back');
  const backImg = backMount && backMount.querySelector('img');
  const quoteEl = document.getElementById('cardQuote');
  if (!hero || !stage || !mover || !tilt || !obj || !img || !backMount) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------- deck */

  const DECK = (window.SHANHAI_DECK || []).map((c) => ({
    slug: c.slug,
    name: c.name,
    quote: c.quote,
    title: c.title,
    meaning: c.meaning,
    keywords: c.keywords,
    intentions: c.intentions,
    moods: c.moods,
  }));
  if (!DECK.length) return;

  let currentCard = 0; // nuwa opening
  let activeIntention = null;
  let activeMood = null;

  function cardSources(card) {
    const base = 'assets/cards/' + card.slug;
    return {
      diffuse: base + '.webp',
      normal: base + '-normal.webp',
      rough: base + '-roughness.webp',
      height: base + '-height.webp',
    };
  }

  const BACK_SOURCES = {
    diffuse: 'assets/cards/cardBack.webp',
    normal: 'assets/cards/cardBackNormal.webp',
    rough: 'assets/cards/cardBackRoughness.webp',
    height: 'assets/cards/cardBackHeight.webp',
  };

  function setQuote(card) {
    if (!quoteEl || !card.quote) return;
    quoteEl.innerHTML =
      '<span class="qmark">「</span><em>' +
      card.quote +
      '</em><span class="qmark">」</span>';
  }

  /* ======================================================== 3D card tilt */

  const MAX_TILT = 4.2;   // deg toward pointer
  const IDLE_AMP = 1.3;   // deg idle sway
  let targetRX = 0;
  let targetRY = 0;
  let curRX = 0;
  let curRY = 0;
  let pointerActive = false;

  function updateTiltFromPoint(clientX, clientY) {
    const r = obj.getBoundingClientRect();
    if (r.width < 1) return;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Normalized offset, softened past the card so far corners don't slam
    // the tilt to its extreme.
    const nx = Math.max(-1, Math.min(1, (clientX - cx) / (window.innerWidth * 0.5)));
    const ny = Math.max(-1, Math.min(1, (clientY - cy) / (window.innerHeight * 0.5)));
    targetRY = nx * MAX_TILT;   // face turns toward pointer horizontally
    targetRX = -ny * MAX_TILT;  // and vertically
    pointerActive = true;
  }

  window.addEventListener('mousemove', (e) => {
    updateTiltFromPoint(e.clientX, e.clientY);
  }, { passive: true });

  // 移动端：手指在牌面上滑动时同样驱动倾斜（不阻止页面滚动——只在牌上跟）
  stage.addEventListener('touchstart', (e) => {
    if (!e.touches[0]) return;
    updateTiltFromPoint(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (!e.touches[0]) return;
    updateTiltFromPoint(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });

  /* Draw-choreography state, all applied inside the one rAF writer:
     flipAngle rides on the tilt's rotateY (180 = back showing); the move*
     values position the whole mount for the fly-in from bottom center. */
  let flipAngle = 0;
  let moveX = 0;
  let moveY = 0;
  let moveRZ = 0;
  let moveScale = 1;
  let shadowMul = 1;

  /* Tiny tween pool: apply(p) receives linear 0..1, shapes its own easing. */
  const tweens = [];
  function tween(dur, apply, done) {
    tweens.push({ t0: performance.now(), dur, apply, done });
  }
  function stepTweens(now) {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      const p = Math.min(1, (now - tw.t0) / tw.dur);
      tw.apply(p);
      if (p >= 1) {
        tweens.splice(i, 1);
        if (tw.done) tw.done();
      }
    }
  }
  const easeOut3 = (p) => 1 - Math.pow(1 - p, 3);

  function applyCardTransforms() {
    mover.style.transform =
      'translate3d(' + moveX.toFixed(2) + 'px,' + moveY.toFixed(2) + 'px,0)' +
      ' rotate(' + moveRZ.toFixed(3) + 'deg) scale(' + moveScale.toFixed(4) + ')';
    tilt.style.transform =
      'rotateX(' + curRX.toFixed(3) + 'deg) rotateY(' + (curRY + flipAngle).toFixed(3) + 'deg)';
  }

  function tiltFrame(now) {
    if (!reduceMotion) {
      const t = now * 0.001;
      const idleX = Math.sin(t * 0.42) * IDLE_AMP;
      const idleY = Math.cos(t * 0.31) * IDLE_AMP;
      const goalRX = targetRX + (pointerActive ? idleX * 0.45 : idleX);
      const goalRY = targetRY + (pointerActive ? idleY * 0.45 : idleY);
      curRX += (goalRX - curRX) * 0.055;
      curRY += (goalRY - curRY) * 0.055;
      stepTweens(now);
      applyCardTransforms();

      if (shadow) {
        // Shadow falls away from the key light: slide opposite the pointer,
        // reusing the smoothed tilt state so it lags with the same easing.
        const nx = curRY / MAX_TILT; // -1…1 pointer side (horizontal)
        const ny = -curRX / MAX_TILT; // -1…1 pointer side (vertical)
        const sx = -nx * 34;
        const sy = 22 - ny * 26;
        // Light farther off-axis → longer, softer, fainter throw.
        const d = Math.min(1, Math.hypot(nx, ny));
        const scale = 1 + d * 0.05;
        shadow.style.transform =
          'translate3d(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px,0) scale(' + scale.toFixed(3) + ')';
        shadow.style.opacity = ((1 - d * 0.3) * shadowMul).toFixed(3);
      }
    }
    requestAnimationFrame(tiltFrame);
  }
  requestAnimationFrame(tiltFrame);

  /* ------------------------------------------------------ draw a card */

  // The WebGL section below upgrades these to also swap shader textures;
  // without GL the fallback <img> still flips and swaps.
  let ensureCardLoaded = (card) => new Promise((resolve) => {
    const el = new Image();
    el.onload = el.onerror = () => resolve();
    el.src = cardSources(card).diffuse;
  });
  let applyCard = (card) => {
    img.src = cardSources(card).diffuse;
    img.alt = card.name + ' — ' + (card.title || '') + '。中国神话神谕卡。';
    setQuote(card);
  };
  // Element for the fly-out clone's front face: the plain diffuse <img>
  // by default, upgraded to a copy of the lit canvas when GL is running.
  let snapshotFront = () => {
    const el = new Image();
    el.src = img.src;
    return el;
  };

  /* Outgoing card: fixed-position clone over the card's home rect, flipping
     to its back while it sails off the top-left corner of the page. */
  function spawnFlyOut(rect) {
    const fly = document.createElement('div');
    fly.className = 'card-fly';
    fly.style.left = rect.left + 'px';
    fly.style.top = rect.top + 'px';
    fly.style.width = rect.width + 'px';
    fly.style.height = rect.height + 'px';

    const inner = document.createElement('div');
    inner.className = 'card-fly-inner';
    const front = document.createElement('div');
    front.className = 'fly-face';
    front.appendChild(snapshotFront());
    const back = document.createElement('div');
    back.className = 'fly-face fly-back';
    const backCopy = new Image();
    backCopy.src = BACK_SOURCES.diffuse;
    back.appendChild(backCopy);
    inner.appendChild(front);
    inner.appendChild(back);
    fly.appendChild(inner);
    document.body.appendChild(fly);

    // Far enough that the card fully clears the top-left corner.
    const ex = -(rect.left + rect.width + 80);
    const ey = -(rect.top + rect.height + 80);

    tween(680, (p) => {
      const q = p * p;            // translation accelerates away
      const r = easeOut3(p);      // flip resolves early, then it just sails
      inner.style.transform =
        'translate3d(' + (ex * q).toFixed(1) + 'px,' + (ey * q).toFixed(1) + 'px,0)' +
        ' rotate(' + (-16 * r).toFixed(2) + 'deg)' +
        ' rotateY(' + (-195 * r).toFixed(2) + 'deg)' +
        ' scale(' + (1 - 0.14 * q).toFixed(4) + ')';
    }, () => fly.remove());
  }

  let flipping = false;

  function pickPool(opts) {
    let pool = DECK.slice();
    const intention = (opts && opts.intention) || activeIntention;
    const mood = (opts && opts.mood) || activeMood;
    if (intention) {
      const f = pool.filter((c) => c.intentions && c.intentions.includes(intention));
      if (f.length) pool = f;
    }
    if (mood) {
      const f = pool.filter((c) => c.moods && c.moods.includes(mood));
      if (f.length) pool = f;
    }
    return pool;
  }

  function pickNext(pool) {
    if (pool.length === 1) return DECK.indexOf(pool[0]);
    let next;
    let guard = 0;
    do {
      const card = pool[Math.floor(Math.random() * pool.length)];
      next = DECK.indexOf(card);
      guard++;
    } while (next === currentCard && guard < 24);
    return next < 0 ? 0 : next;
  }

  /** Instant scroll (bypass CSS scroll-behavior: smooth) for rAF-driven follow.
   *  Only touch one scroll root — setting both html+body causes double-jumps.
   *  Integer Y avoids subpixel scroll thrash that shimmers background layers. */
  function scrollToY(y) {
    const top = Math.max(0, Math.round(y));
    if (Math.abs(top - Math.round(window.scrollY || 0)) < 1) return;
    const root = document.documentElement;
    const prev = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    window.scrollTo(0, top);
    root.style.scrollBehavior = prev;
  }

  /** Keep the rising card near a comfortable viewport anchor while it climbs. */
  function followCardInView(cardMoveY, cardH) {
    const stageTop = stage.getBoundingClientRect().top;
    // Visual center of the flying card (stage is fixed; mover carries moveY)
    const visualCenter = stageTop + cardMoveY + cardH * 0.42;
    // Slightly higher anchor so the climb feels like an upward glide
    const anchor = window.innerHeight * 0.32;
    const delta = visualCenter - anchor;
    if (Math.abs(delta) < 0.4) return;
    // Strong follow so the page tracks the card without lagging behind
    scrollToY(window.scrollY + delta * 0.98);
  }

  /** Ease page scroll to rest with the settled card nicely in frame. */
  function settleScrollToCard(dur) {
    if (reduceMotion) {
      stage.scrollIntoView({ block: 'center', behavior: 'auto' });
      return;
    }
    const start = window.scrollY;
    const stageDocTop = stage.getBoundingClientRect().top + window.scrollY;
    // Keep the full card in the upper portion of the viewport
    const target = Math.max(0, stageDocTop - Math.min(100, window.innerHeight * 0.12));
    if (Math.abs(target - start) < 4) return;
    tween(dur || 560, (p) => {
      const m = easeOut3(p);
      scrollToY(start + (target - start) * m);
    });
  }

  function drawCard(opts) {
    opts = opts || {};
    if (flipping) return;
    flipping = true;
    const follow = !!opts.followScroll && !reduceMotion;
    const pool = pickPool(opts);
    const next = pickNext(pool);
    currentCard = next;
    const card = DECK[next];
    const loadP = ensureCardLoaded(card);

    if (reduceMotion) {
      loadP.then(() => {
        applyCard(card);
        settleScrollToCard(0);
        showReading(card, opts);
        flipping = false;
      });
      return;
    }

    const rect = stage.getBoundingClientRect();
    const cardH = rect.height;
    spawnFlyOut(rect);

    // Park the real card below the hero (clipped out of view), back showing,
    // centered on the page. Applied synchronously so it never flashes at home
    // under the clone.
    const heroRect = hero.getBoundingClientRect();
    moveX = window.innerWidth / 2 - (rect.left + rect.width / 2);
    moveY = (heroRect.bottom + rect.height * 0.6) - (rect.top + rect.height / 2);
    moveRZ = 9;
    moveScale = 0.95;
    flipAngle = 180;
    shadowMul = 0; // the clone carries its own shadow while the mount is away
    applyCardTransforms();

    // Document Y of the stage home (stable; not affected by card transform)
    const stageDocY = rect.top + window.scrollY;
    const scrollStart = window.scrollY;
    // Final resting scroll: card sits cleanly in the upper viewport
    const scrollEnd = Math.max(0, stageDocY - Math.min(96, window.innerHeight * 0.12));

    loadP.then(() => {
      applyCard(card);
      // A short beat so the outgoing card reads before the new one rises.
      setTimeout(() => {
        const sx = moveX;
        const sy = moveY;
        const srz = moveRZ;
        // Rise duration — page scroll is locked to the same ease curve so it
        // feels like the viewport is riding up with the card.
        const riseMs = follow ? 1100 : 920;
        tween(riseMs, (p) => {
          const m = easeOut3(p);
          moveX = sx * (1 - m);
          moveY = sy * (1 - m);
          moveRZ = srz * (1 - m);
          moveScale = 0.95 + 0.05 * m;
          // Back shows for the first stretch of the climb, then the card
          // turns over and lands face-up just before settling.
          const f = Math.min(1, Math.max(0, (p - 0.12) / 0.72));
          flipAngle = 180 * (1 - easeOut3(f));

          if (follow) {
            // Blend: mostly ease scroll-up to the card, with a light track of
            // the card's live visual center so motion stays locked together.
            const eased = scrollStart + (scrollEnd - scrollStart) * m;
            const visualCenter = stage.getBoundingClientRect().top + moveY + cardH * 0.42;
            const anchor = window.innerHeight * 0.34;
            const tracked = window.scrollY + (visualCenter - anchor);
            // Bias toward the upward ease so we never dive further down first
            const blended = eased * 0.72 + tracked * 0.28;
            // Never scroll downward past where we started (always 上滑)
            scrollToY(Math.min(scrollStart, blended));
          }
        }, () => {
          flipAngle = 0;
          tween(260, (p) => { shadowMul = p; });
          if (follow) {
            // Snap residual to exact rest pose
            settleScrollToCard(420);
            setTimeout(() => {
              showReading(card, opts);
              flipping = false;
            }, 360);
          } else {
            showReading(card, opts);
            flipping = false;
          }
        });
      }, 170);
    });
  }

  /* ------------------------------------------------ reading / UI chrome */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function hideReading(animated) {
    const readingEl = document.getElementById('readingResult');
    if (!readingEl || readingEl.hidden) return Promise.resolve();
    if (!animated || reduceMotion) {
      readingEl.hidden = true;
      readingEl.classList.remove('is-leaving', 'is-enter');
      return Promise.resolve();
    }
    readingEl.classList.remove('is-enter');
    readingEl.classList.add('is-leaving');
    // Keep attribute toggle at end of fade so layout collapses once, softly
    return new Promise((resolve) => {
      setTimeout(() => {
        readingEl.hidden = true;
        readingEl.classList.remove('is-leaving');
        // Double-rAF: let the browser paint collapse before card choreography
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      }, 340);
    });
  }

  function showReading(card, opts) {
    const readingEl = document.getElementById('readingResult');
    if (!readingEl) return;
    const intentions = window.SHANHAI_INTENTIONS || {};
    const moods = window.SHANHAI_MOODS || {};
    const intentKey = (opts && opts.intention) || activeIntention;
    const moodKey = (opts && opts.mood) || null;
    const intentLabel = intentKey && intentions[intentKey] ? intentions[intentKey].label : null;
    const moodLabel = moodKey && moods[moodKey] ? moods[moodKey].label : null;
    const tags = (card.keywords || [])
      .map((k) => '<span class="tag">' + escapeHtml(k) + '</span>')
      .join('');

    readingEl.hidden = false;
    readingEl.classList.remove('is-leaving');
    readingEl.classList.add('is-enter');
    readingEl.innerHTML =
      '<div class="reading-inner">' +
      '<button type="button" class="reading-close" aria-label="关闭">×</button>' +
      '<p class="reading-kicker">' +
      escapeHtml(intentLabel || moodLabel || '今日神谕') +
      '</p>' +
      '<h2 class="reading-name">' + escapeHtml(card.name) +
      '<span class="reading-title">' + escapeHtml(card.title || '') + '</span></h2>' +
      '<p class="reading-quote">「' + escapeHtml(card.quote || '') + '」</p>' +
      '<p class="reading-body">' + escapeHtml(card.meaning || '') + '</p>' +
      '<div class="reading-tags">' + tags + '</div>' +
      '<button type="button" class="btn-redraw">再抽一卦</button>' +
      '</div>';

    readingEl.querySelector('.reading-close').addEventListener('click', () => {
      hideReading(true);
    });
    readingEl.querySelector('.btn-redraw').addEventListener('click', () => {
      if (flipping) return;
      const btn = readingEl.querySelector('.btn-redraw');
      if (btn) {
        btn.disabled = true;
        btn.classList.add('is-busy');
      }
      // Fade reading out, then draw while the page rides up with the card
      hideReading(true).then(() => {
        drawCard({ intention: activeIntention, followScroll: true });
      });
    });

    // 不自动滚到「今日神谕」：
    // - 抽取神谕：留在当前视口看牌面，用户自己下滑看卦辞
    // - 再抽一卦：followScroll 已随牌上滑，若再滚到卦辞会「先上后下」打架
    // 桌面再抽时若卦辞完全在折线以下，最多轻推一截（仍优先保住牌面）
    if (opts && opts.followScroll && window.innerWidth >= 1120) {
      setTimeout(() => {
        const rr = readingEl.getBoundingClientRect();
        const stageR = stage.getBoundingClientRect();
        if (rr.top > window.innerHeight - 48 && stageR.bottom > 120) {
          const overflow = rr.top - window.innerHeight * 0.72;
          const start = window.scrollY;
          const maxDown = Math.max(0, stageR.top - 72);
          const target = Math.min(start + overflow, start + maxDown);
          if (target > start + 8) {
            tween(640, (p) => {
              scrollToY(start + (target - start) * easeOut3(p));
            });
          }
        }
      }, 200);
    }
  }

  const drawBtn = document.querySelector('.action-primary, [data-action="draw"]');
  if (drawBtn) {
    drawBtn.addEventListener('click', (e) => {
      e.preventDefault();
      activeMood = null;
      drawCard({ intention: activeIntention });
    });
  }

  document.querySelectorAll('[data-intention]').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      const key = chip.getAttribute('data-intention');
      if (activeIntention === key) {
        activeIntention = null;
        chip.classList.remove('is-active');
      } else {
        activeIntention = key;
        document.querySelectorAll('[data-intention]').forEach((c) => c.classList.remove('is-active'));
        chip.classList.add('is-active');
      }
    });
  });

  /* mood modal */
  const moodModal = document.getElementById('moodModal');
  const moodGrid = document.getElementById('moodGrid');
  const moodBtn = document.querySelector('[data-action="mood"]');

  function openMoodModal() {
    if (!moodModal || !moodGrid) return;
    const moods = window.SHANHAI_MOODS || {};
    moodGrid.innerHTML = '';
    Object.entries(moods).forEach(([key, m]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mood-chip';
      btn.innerHTML = '<span class="mood-emoji">' + m.emoji + '</span><span>' + escapeHtml(m.label) + '</span>';
      btn.addEventListener('click', () => {
        moodModal.hidden = true;
        document.body.classList.remove('modal-open');
        activeMood = key;
        drawCard({ mood: key, intention: activeIntention });
        activeMood = null;
      });
      moodGrid.appendChild(btn);
    });
    moodModal.hidden = false;
    document.body.classList.add('modal-open');
  }

  if (moodBtn) {
    moodBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openMoodModal();
    });
  }
  if (moodModal) {
    moodModal.querySelector('.modal-backdrop')?.addEventListener('click', () => {
      moodModal.hidden = true;
      document.body.classList.remove('modal-open');
    });
    moodModal.querySelector('.modal-close')?.addEventListener('click', () => {
      moodModal.hidden = true;
      document.body.classList.remove('modal-open');
    });
  }

  // date + lunar phase (synodic month from known new moon)
  const moonChip = document.getElementById('moonChip');
  if (moonChip) {
    const phases = [
      { name: '朔月', tip: '适合立愿', max: 1.85 },
      { name: '蛾眉月', tip: '萌发之象', max: 5.5 },
      { name: '上弦月', tip: '进取之时', max: 9.2 },
      { name: '盈凸月', tip: '蓄势待发', max: 12.9 },
      { name: '望月', tip: '圆满洞见', max: 16.6 },
      { name: '亏凸月', tip: '收敛反思', max: 20.3 },
      { name: '下弦月', tip: '放下执念', max: 24.0 },
      { name: '残月', tip: '静待新生', max: 29.53058867 },
    ];
    // Known new moon: 2000-01-06 18:14 UTC
    const SYNODIC = 29.53058867;
    const knownNew = Date.UTC(2000, 0, 6, 18, 14, 0);
    const now = new Date();
    let age = ((now.getTime() - knownNew) / 86400000) % SYNODIC;
    if (age < 0) age += SYNODIC;

    let phase = phases[phases.length - 1];
    for (let i = 0; i < phases.length; i++) {
      if (age <= phases[i].max) { phase = phases[i]; break; }
    }
    const daysToNew = Math.max(1, Math.ceil(SYNODIC - age));

    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const d = now.getDate();
    const dateEl = moonChip.querySelector('.moon-date');
    const nameEl = moonChip.querySelector('.moon-name');
    const daysEl = moonChip.querySelector('.moon-days');
    if (dateEl) dateEl.textContent = y + '年' + m + '月' + d + '日';
    if (nameEl) nameEl.textContent = phase.name + ' · ' + phase.tip;
    if (daysEl) daysEl.textContent = '距朔 ' + daysToNew + ' 日';
  }

  window.ShanhaiApp = { drawCard, DECK };

  /* ==================================================== WebGL lighting */

  const VERT = `#version 300 es
  in vec2 aPos;
  out vec2 vUv;
  void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }`;

  const FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 frag;

  uniform sampler2D uDiffuse;
  uniform sampler2D uNormal;
  uniform sampler2D uRough;
  uniform sampler2D uHeight;

  uniform vec2  uMouse;       // pointer in canvas UV (y up)
  uniform float uHasMouse;
  uniform float uParallax;
  uniform float uLightZ;
  uniform float uNormalStr;
  uniform float uSpecStr;
  uniform float uDiffuseAmt;
  uniform float uAmbientAmt;
  uniform vec3  uLightColor;
  uniform vec3  uAmbientColor;
  uniform float uMotion;

  void main() {
    vec2 uv = vUv;

    // Height parallax: raised pixels drift against the pointer.
    float h0 = texture(uHeight, uv).r;
    if (uMotion > 0.5 && uHasMouse > 0.5) {
      vec2 viewOff = (uMouse - vec2(0.5)) * 2.0;
      uv = clamp(uv - viewOff * (h0 * uParallax), 0.001, 0.999);
    }

    vec4 diff = texture(uDiffuse, uv);
    float a = diff.a;
    if (a < 0.004) { frag = vec4(0.0); return; }

    vec3 albedo = diff.rgb;
    float rough = texture(uRough, uv).r;
    float h = texture(uHeight, uv).r;

    vec3 nRaw = texture(uNormal, uv).xyz * 2.0 - 1.0;
    nRaw.xy *= uNormalStr;
    vec3 N = normalize(vec3(nRaw.xy, max(nRaw.z, 0.08)));

    vec3 V = vec3(0.0, 0.0, 1.0);
    float ambRelief = 0.74 + 0.26 * max(N.z, 0.0);
    vec3 col = albedo * uAmbientColor * uAmbientAmt * ambRelief;

    // Candle-warm key light following the pointer.
    vec2 lightUv = (uHasMouse > 0.5) ? uMouse : vec2(0.44, 0.66);
    vec3 L = normalize(vec3(lightUv.x - uv.x, lightUv.y - uv.y, uLightZ));
    float ndl = max(dot(N, L), 0.0);
    float wrap = ndl * 0.8 + 0.2;
    col += albedo * uLightColor * (wrap * uDiffuseAmt);

    // Roughness-shaped sheen: gilt linework catches, matte ink stays quiet.
    vec3 H = normalize(L + V);
    float shininess = mix(52.0, 6.0, clamp(rough, 0.0, 1.0));
    float spec = pow(max(dot(N, H), 0.0), shininess);
    spec *= (1.0 - rough * 0.85) * uSpecStr;
    spec *= 0.82 + 0.34 * h;
    col += uLightColor * spec;

    // Faint warm rim when the key rakes from the side.
    float rim = pow(1.0 - max(dot(N, V), 0.0), 2.4);
    float side = 1.0 - abs(L.z);
    col += uLightColor * rim * side * 0.1 * (1.0 - rough * 0.5);

    col = clamp(col, 0.0, 1.0);
    frag = vec4(col * a, a);
  }`;

  /* One lit plane: its own canvas + GL2 context over a mount element.
     flipMouseX mirrors the pointer for the back face, whose plane is
     rotated 180° so screen-left is texture-right. */
  function createLitLayer(mount, imgEl, flipMouseX) {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'default',
    });
    if (!gl) return null;

    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('card shader:', gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    }

    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('card lighting link:', gl.getProgramInfoLog(prog));
      return null;
    }
    gl.useProgram(prog);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const U = {};
    [
      'uDiffuse', 'uNormal', 'uRough', 'uHeight',
      'uMouse', 'uHasMouse', 'uParallax', 'uLightZ', 'uNormalStr',
      'uSpecStr', 'uDiffuseAmt', 'uAmbientAmt', 'uLightColor', 'uAmbientColor',
      'uMotion',
    ].forEach((name) => { U[name] = gl.getUniformLocation(prog, name); });

    gl.uniform1i(U.uDiffuse, 0);
    gl.uniform1i(U.uNormal, 1);
    gl.uniform1i(U.uRough, 2);
    gl.uniform1i(U.uHeight, 3);

    // Candlelight key over a cool moonlit ambient — matches the night scene.
    gl.uniform3f(U.uLightColor, 1.0, 0.92, 0.78);
    gl.uniform3f(U.uAmbientColor, 0.82, 0.83, 0.88);
    gl.uniform1f(U.uAmbientAmt, 0.56);
    gl.uniform1f(U.uDiffuseAmt, 0.62);
    gl.uniform1f(U.uSpecStr, 0.34);
    gl.uniform1f(U.uNormalStr, 1.35);
    gl.uniform1f(U.uLightZ, 0.5);
    gl.uniform1f(U.uParallax, reduceMotion ? 0.0 : 0.0034);
    gl.uniform1f(U.uMotion, reduceMotion ? 0.0 : 1.0);
    gl.uniform1f(U.uHasMouse, 0.0);
    gl.uniform2f(U.uMouse, 0.44, 0.66);

    function makeTex(unit, internalFormat, format) {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const px = internalFormat === gl.RGBA ? new Uint8Array([0, 0, 0, 0]) : new Uint8Array([128, 128, 255]);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 1, 1, 0, format, gl.UNSIGNED_BYTE, px);
      return t;
    }

    const texDiffuse = makeTex(0, gl.RGBA, gl.RGBA);
    const texNormal = makeTex(1, gl.RGB, gl.RGB);
    const texRough = makeTex(2, gl.RGB, gl.RGB);
    const texHeight = makeTex(3, gl.RGB, gl.RGB);

    mount.appendChild(canvas);

    function upload(tex, unit, image, internalFormat, format) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, format, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    let ready = false;
    let disposed = false;
    let needsDraw = true;
    const mouse = { x: 0.44, y: 0.66 };
    let hasMouse = false;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    function resize() {
      // Layout size, not getBoundingClientRect: the mount spends time mid-flip
      // and mid-flight, and transformed rects would thrash the buffer.
      const w0 = canvas.offsetWidth;
      const h0 = canvas.offsetHeight;
      if (w0 < 2 || h0 < 2) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(w0 * dpr));
      const h = Math.max(1, Math.round(h0 * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        needsDraw = true;
      }
    }

    function draw() {
      resize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.uniform2f(U.uMouse, flipMouseX ? 1 - mouse.x : mouse.x, mouse.y);
      gl.uniform1f(U.uHasMouse, hasMouse ? 1.0 : 0.0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texDiffuse);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texNormal);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texRough);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, texHeight);

      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function frame() {
      if (!ready) return;
      if (needsDraw) {
        needsDraw = false;
        draw();
      }
      requestAnimationFrame(frame);
    }

    return {
      canvas,
      setTextures(set) {
        if (disposed) return;
        upload(texDiffuse, 0, set.diffuse, gl.RGBA, gl.RGBA);
        upload(texNormal, 1, set.normal, gl.RGB, gl.RGB);
        upload(texRough, 2, set.rough, gl.RGB, gl.RGB);
        upload(texHeight, 3, set.height, gl.RGB, gl.RGB);
        needsDraw = true;
        if (!ready) {
          ready = true;
          resize();
          mount.classList.add('is-webgl');
          if (imgEl) imgEl.setAttribute('aria-hidden', 'true');
          requestAnimationFrame(frame);
        }
      },
      pointer(e) {
        if (!ready) return;
        const r = canvas.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;
        // Allow overshoot so the key light can rake in from off-card.
        const x = (e.clientX - r.left) / r.width;
        const y = 1.0 - (e.clientY - r.top) / r.height;
        mouse.x = Math.min(1.4, Math.max(-0.4, x));
        mouse.y = Math.min(1.4, Math.max(-0.4, y));
        hasMouse = true;
        needsDraw = true;
      },
      drawNow() {
        if (ready) draw();
      },
      redraw() { needsDraw = true; },
      onResize() {
        if (!ready) return;
        resize();
        needsDraw = true;
      },
      setUniform(name, args) {
        if (!U[name]) return;
        gl.useProgram(prog);
        if (name === 'uMouse' && args.length >= 2) {
          mouse.x = args[0];
          mouse.y = args[1];
          hasMouse = true;
        }
        if (name === 'uHasMouse' && args.length >= 1) hasMouse = args[0] > 0.5;
        if (args.length === 1) gl.uniform1f(U[name], args[0]);
        else if (args.length === 2) gl.uniform2f(U[name], args[0], args[1]);
        else if (args.length === 3) gl.uniform3f(U[name], args[0], args[1], args[2]);
        needsDraw = true;
      },
      dispose() {
        disposed = true;
        ready = false;
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        mount.classList.remove('is-webgl');
        if (imgEl) imgEl.removeAttribute('aria-hidden');
      },
    };
  }

  const frontLayer = createLitLayer(obj, img, false);
  const backLayer = createLitLayer(backMount, backImg, true);
  const layers = [frontLayer, backLayer].filter(Boolean);
  if (!layers.length) return; // img fallbacks stay in place

  if (!reduceMotion) {
    window.addEventListener('mousemove', (e) => {
      layers.forEach((L) => L.pointer(e));
    }, { passive: true });

    // 触摸驱动 WebGL 烛光（与桌面鼠标一致）
    const onTouchLight = (e) => {
      const t = e.touches[0];
      if (!t) return;
      const fake = { clientX: t.clientX, clientY: t.clientY };
      layers.forEach((L) => L.pointer(fake));
    };
    stage.addEventListener('touchstart', onTouchLight, { passive: true });
    stage.addEventListener('touchmove', onTouchLight, { passive: true });
  }
  window.addEventListener('resize', () => {
    layers.forEach((L) => L.onResize());
  }, { passive: true });

  /* -------------------------------------------------- texture loading */

  function loadTex(src) {
    return new Promise((resolve, reject) => {
      const el = new Image();
      el.decoding = 'async';
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to load ' + src));
      el.src = src;
    });
  }

  function loadSet(srcs) {
    return Promise.all([
      loadTex(srcs.diffuse),
      loadTex(srcs.normal),
      loadTex(srcs.rough),
      loadTex(srcs.height),
    ]).then(([diffuse, normal, rough, height]) => ({ diffuse, normal, rough, height }));
  }

  /* Per-card texture image cache: slug → Promise<{diffuse,normal,rough,height}> */
  const cardCache = new Map();
  function loadCard(card) {
    if (!cardCache.has(card.slug)) cardCache.set(card.slug, loadSet(cardSources(card)));
    return cardCache.get(card.slug);
  }

  if (frontLayer) {
    ensureCardLoaded = (card) => loadCard(card).then(() => undefined);

    applyCard = (card) => {
      img.src = cardSources(card).diffuse;
      img.alt = card.name + ' — ' + (card.title || '') + '。中国神话神谕卡。';
      setQuote(card);
      loadCard(card).then((set) => frontLayer.setTextures(set));
    };

    snapshotFront = () => {
      const src = frontLayer.canvas;
      if (src.width > 1 && src.height > 1) {
        try {
          frontLayer.drawNow(); // make sure the buffer is current
          const copy = document.createElement('canvas');
          copy.width = src.width;
          copy.height = src.height;
          copy.getContext('2d').drawImage(src, 0, 0);
          return copy;
        } catch (err) { /* fall through to the plain img */ }
      }
      const el = new Image();
      el.src = img.src;
      return el;
    };

    loadCard(DECK[currentCard]).then((set) => {
      frontLayer.setTextures(set);
      // Warm the rest of the deck so a draw never waits on the network.
      DECK.forEach((c) => loadCard(c));
    }).catch((err) => {
      console.warn('card lighting fallback to img:', err);
      frontLayer.dispose();
    });
  }

  if (backLayer) {
    loadSet(BACK_SOURCES).then((set) => {
      backLayer.setTextures(set);
    }).catch((err) => {
      console.warn('card back lighting fallback to img:', err);
      backLayer.dispose();
    });
  }

  // Console knobs for live tuning (front face; use CardLighting.back for the back).
  function knobs(layer) {
    return layer ? {
      set(name, ...args) { layer.setUniform(name, args); },
      redraw() { layer.redraw(); },
    } : null;
  }
  window.CardLighting = Object.assign(knobs(frontLayer) || {}, { back: knobs(backLayer) });
})();
