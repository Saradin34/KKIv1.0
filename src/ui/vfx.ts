/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — VFX-движок прототипа (src/ui/vfx.ts)
   ---------------------------------------------------------------------
   Аналог Unity-стека из docs/VISUAL_STACK.md, разделы 4 и 6, средствами
   CSS/SVG/Canvas. Никакой игровой логики: модуль только рисует.

   Соответствие для будущего порта в Unity:
     shake()          → CameraRig.Punch(direction, power)  + DOTween
     hitStop()        → Time.timeScale на 60 мс
     impactRing()     → префаб VFX_ImpactRing (All In 1 VFX)
     sparkBurst()     → VFX Graph / Particle System
     slash()          → префаб VFX_Slash (квад + All In 1 Sprite)
     projectile()     → DOTween-путь + Trail Renderer
     ripple()         → префаб VFX_Ripple (вода/Эхо)
     pillar()         → Action RPG FX: loot beam → столп руны
     motes()          → BG Particle Effects
     groundDecal()    → URP Decal Projector
     glitch()         → UrpVfx (бесплатный, GitHub)
     dissolve()       → All In 1 Sprite Shader: radial dissolve
     smokeRing(), wisp() → префабы смерти
     screenFlash(), vignettePulse(), aberration() → URP Volume (раздел 4)
   ===================================================================== */

/** Точки экрана в координатах viewport. */
export interface Pt { x: number; y: number }

export type VfxColor = string;

const LAYER_ID = 'vfxLayer';
const CANVAS_ID = 'vfxCanvas';
const STYLE_ID = 'vfxStyle';

/** Цвета по стихиям (Element из движка) — соответствуют арт-промптам фракций. */
export const ELEMENT_VFX: Record<string, VfxColor> = {
  None: '#d8b45a',
  Fire: '#ff7a18',
  Water: '#4fa8e0',
  Earth: '#7fae4a',
  Air: '#9fe8dd',
  Chaos: '#b06cf0',
};

/** Палитры фракций для ambient-частиц и акцентов. */
export const FACTION_VFX: Record<string, { primary: VfxColor; secondary: VfxColor; accent: VfxColor }> = {
  Aurites: { primary: '#f5d76e', secondary: '#fff3c4', accent: '#d8b45a' },
  Necrus: { primary: '#a855c9', secondary: '#d59bf0', accent: '#5c1f70' },
  Terramorph: { primary: '#5aa648', secondary: '#a8d18a', accent: '#2f5a24' },
  Pyromancer: { primary: '#ff7a18', secondary: '#ffd08a', accent: '#a02a06' },
  Ethereal: { primary: '#3fd6c8', secondary: '#c8fff8', accent: '#1b6f68' },
  Neutral: { primary: '#9aa3ad', secondary: '#dfe4ea', accent: '#4a5058' },
};

/* =====================================================================
   Инфраструктура: слой, канвас, стили
   ===================================================================== */

let layer: HTMLElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let reducedMotion = false;
let systemReducedMotion = false;
let shakeRoot: HTMLElement | null = null;
let ambientRunning = false;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${LAYER_ID}{position:fixed;inset:0;pointer-events:none;z-index:120;overflow:hidden}
#${CANVAS_ID}{position:fixed;inset:0;pointer-events:none;z-index:1;opacity:.85}
.vfx-shake{will-change:transform}

.vfx-ring{position:absolute;border-radius:50%;transform:translate(-50%,-50%) scale(.2);
  border:3px solid currentColor;box-shadow:0 0 22px currentColor, inset 0 0 18px currentColor;opacity:0}
.vfx-ring.go{animation:vfxRing .55s cubic-bezier(.15,.75,.3,1) forwards}
@keyframes vfxRing{0%{opacity:0;transform:translate(-50%,-50%) scale(.15)}
  18%{opacity:.95}100%{opacity:0;transform:translate(-50%,-50%) scale(1)}}

.vfx-spark{position:absolute;width:4px;height:4px;border-radius:50%;background:currentColor;
  box-shadow:0 0 8px currentColor;transform:translate(-50%,-50%);opacity:0}
.vfx-spark.go{animation:vfxSpark var(--d,.7s) cubic-bezier(.2,.7,.35,1) forwards}
@keyframes vfxSpark{0%{opacity:1;transform:translate(-50%,-50%) translate(0,0) scale(1.25)}
  70%{opacity:.85}
  100%{opacity:0;transform:translate(-50%,-50%) translate(var(--dx),var(--dy)) scale(.15)}}

.vfx-slash{position:absolute;transform:translate(-50%,-50%) rotate(var(--a,0deg));opacity:0;
  filter:drop-shadow(0 0 8px currentColor)}
.vfx-slash.go{animation:vfxSlash .34s ease-out forwards}
@keyframes vfxSlash{0%{opacity:0;transform:translate(-50%,-50%) rotate(var(--a,0deg)) scale(.5)}
  22%{opacity:1;transform:translate(-50%,-50%) rotate(var(--a,0deg)) scale(1.06)}
  100%{opacity:0;transform:translate(-50%,-50%) rotate(var(--a,0deg)) scale(1.22)}}

.vfx-pillar{position:absolute;transform:translateX(-50%);opacity:0;
  background:linear-gradient(0deg,transparent 0%,currentColor 22%,currentColor 55%,transparent 100%);
  filter:blur(1.5px);mix-blend-mode:screen}
.vfx-pillar.go{animation:vfxPillar .95s ease-out forwards}
@keyframes vfxPillar{0%{opacity:0;transform:translateX(-50%) scaleY(.2)}
  20%{opacity:.9;transform:translateX(-50%) scaleY(1)}
  100%{opacity:0;transform:translateX(-50%) scaleY(1.05)}}

.vfx-mote{position:absolute;border-radius:50%;background:currentColor;box-shadow:0 0 10px currentColor;
  transform:translate(-50%,-50%);opacity:0}
.vfx-mote.go{animation:vfxMote var(--d,1.4s) ease-out forwards}
@keyframes vfxMote{0%{opacity:0;transform:translate(-50%,-50%) scale(.4)}
  22%{opacity:.9}100%{opacity:0;transform:translate(-50%,calc(-50% + var(--dy,-70px))) scale(1.05)}}

.vfx-decal{position:absolute;transform:translate(-50%,-50%) scale(.6) rotateX(58deg);opacity:0;
  animation:vfxDecal var(--life,1.6s) ease-out forwards}
@keyframes vfxDecal{0%{opacity:0;transform:translate(-50%,-50%) scale(.4) rotateX(58deg)}
  14%{opacity:.85;transform:translate(-50%,-50%) scale(1) rotateX(58deg)}
  70%{opacity:.55}100%{opacity:0;transform:translate(-50%,-50%) scale(1.06) rotateX(58deg)}}

.vfx-summon-sigil{position:absolute;transform:translate(-50%,-50%) scale(.18) rotate(-34deg);opacity:0;
  filter:drop-shadow(0 0 7px currentColor) drop-shadow(0 0 20px currentColor);mix-blend-mode:screen}
.vfx-summon-sigil.go{animation:vfxSummonSigil .78s cubic-bezier(.18,.78,.22,1) forwards}
.vfx-summon-sigil svg{display:block;width:100%;height:100%;overflow:visible}
.vfx-summon-sigil .orbit{stroke-dasharray:3 4;animation:vfxSigilOrbit 2.4s linear infinite}
.vfx-summon-sigil .etch{stroke-dasharray:2 3;opacity:.72}
@keyframes vfxSummonSigil{0%{opacity:0;transform:translate(-50%,-50%) scale(.16) rotate(-34deg);filter:blur(3px) drop-shadow(0 0 4px currentColor)}
  25%{opacity:.98;filter:blur(0) drop-shadow(0 0 10px currentColor) drop-shadow(0 0 24px currentColor)}
  62%{opacity:.76;transform:translate(-50%,-50%) scale(1.04) rotate(8deg)}
  100%{opacity:0;transform:translate(-50%,-50%) scale(1.32) rotate(24deg);filter:blur(1.5px) drop-shadow(0 0 16px currentColor)}}
@keyframes vfxSigilOrbit{to{stroke-dashoffset:-28}}

.vfx-flash{position:fixed;inset:0;background:currentColor;opacity:0;mix-blend-mode:screen}
.vfx-flash.go{animation:vfxFlash var(--d,.28s) ease-out forwards}
@keyframes vfxFlash{0%{opacity:var(--a,.5)}100%{opacity:0}}

.vfx-vigpulse{position:fixed;inset:0;opacity:0;
  background:radial-gradient(ellipse at center, transparent 42%, currentColor 100%)}
.vfx-vigpulse.go{animation:vfxVig .5s ease-out forwards}
@keyframes vfxVig{0%{opacity:var(--a,.65)}100%{opacity:0}}

.vfx-smoke{position:absolute;border-radius:50%;transform:translate(-50%,-50%) scale(.3);opacity:0;
  background:radial-gradient(circle,currentColor 0%,transparent 68%);filter:blur(6px)}
.vfx-smoke.go{animation:vfxSmoke .85s ease-out forwards}
@keyframes vfxSmoke{0%{opacity:0;transform:translate(-50%,-50%) scale(.3)}
  25%{opacity:.6}100%{opacity:0;transform:translate(-50%,-50%) scale(1.9)}}

.vfx-wisp{position:absolute;width:10px;height:10px;border-radius:50%;background:currentColor;
  box-shadow:0 0 16px currentColor,0 0 34px currentColor;transform:translate(-50%,-50%);opacity:0}

.vfx-proj{position:absolute;width:12px;height:12px;border-radius:50%;background:currentColor;
  box-shadow:0 0 16px currentColor,0 0 40px currentColor;transform:translate(-50%,-50%)}
.vfx-trail{position:absolute;height:3px;border-radius:2px;background:linear-gradient(90deg,transparent,currentColor);
  transform-origin:0 50%;opacity:.85;filter:blur(.4px)}

.vfx-dissolve{animation:vfxDissolve .62s ease-in forwards}
@keyframes vfxDissolve{0%{opacity:1;filter:none}
  55%{opacity:.55;filter:blur(1px) saturate(.4)}
  100%{opacity:0;filter:blur(7px) saturate(0) brightness(1.6);transform:scale(.9)}}

.vfx-glitch{animation:vfxGlitch .34s steps(2,end) 1}
@keyframes vfxGlitch{0%{filter:none;transform:none}
  20%{filter:contrast(1.5) saturate(2) hue-rotate(-18deg);transform:translateX(3px)}
  40%{filter:invert(.12) saturate(3);transform:translateX(-4px) skewX(1.2deg)}
  60%{filter:contrast(1.3) hue-rotate(22deg);transform:translateX(2px)}
  100%{filter:none;transform:none}}

.vfx-haze{position:absolute;border-radius:50%;opacity:.35;mix-blend-mode:screen;
  filter:url(#vfxHeat);background:radial-gradient(circle,currentColor,transparent 70%)}
`;
  const n = document.createElement('style');
  n.id = STYLE_ID;
  n.textContent = css;
  document.head.appendChild(n);
}

/** SVG-фильтры (тепловое марево, глитч) — инжектим один раз. */
function ensureSvgFilters(): void {
  if (document.getElementById('vfxSvgFilters')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'vfxSvgFilters';
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.innerHTML = `
  <defs>
    <filter id="vfxHeat" x="-30%" y="-30%" width="160%" height="160%">
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.05" numOctaves="2" seed="7" result="n">
        <animate attributeName="baseFrequency" dur="7s" values="0.012 0.05;0.02 0.07;0.012 0.05" repeatCount="indefinite"/>
      </feTurbulence>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="14" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="vfxAberr" x="-10%" y="-10%" width="120%" height="120%">
      <feColorMatrix in="SourceGraphic" type="matrix" result="r"
        values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/>
      <feOffset in="r" dx="2.5" dy="0" result="ro"/>
      <feColorMatrix in="SourceGraphic" type="matrix" result="b"
        values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"/>
      <feOffset in="b" dx="-2.5" dy="0" result="bo"/>
      <feBlend in="ro" in2="SourceGraphic" mode="screen" result="rb"/>
      <feBlend in="bo" in2="rb" mode="screen"/>
    </filter>
    <filter id="vfxGrain">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" stitchTiles="stitch" result="n">
        <animate attributeName="seed" dur="1.1s" values="1;7;13;21;3;1" repeatCount="indefinite"/>
      </feTurbulence>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.16" intercept="0"/></feComponentTransfer>
    </filter>
  </defs>`;
  document.body.appendChild(svg);
}

export function vfxInit(root?: HTMLElement | null, opts: { reducedMotion?: boolean } = {}): void {
  ensureStyle();
  ensureSvgFilters();
  if (!layer) {
    layer = document.createElement('div');
    layer.id = LAYER_ID;
    document.body.appendChild(layer);
  }
  if (!canvas) {
    // В headless-средах (jsdom без пакета canvas) 2D-контекста нет: ambient-частицы
    // отключаются, остальной VFX продолжает работать на DOM/SVG.
    const c = document.createElement('canvas');
    c.id = CANVAS_ID;
    const context = safeCtx(c);
    if (context) {
      canvas = c;
      ctx = context;
      document.body.insertBefore(canvas, document.body.firstChild);
      resizeCanvas();
      window.addEventListener('resize', resizeCanvas);
    }
  }
  shakeRoot = root ?? document.getElementById('battle') ?? document.body;
  shakeRoot.classList.add('vfx-shake');
  try {
    systemReducedMotion = typeof window.matchMedia === 'function' &&
      !!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { systemReducedMotion = false; }
  reducedMotion = opts.reducedMotion === true || systemReducedMotion;
}

/**
 * Принудительно включить/выключить «лёгкие эффекты» (настройка интерфейса).
 * Системный prefers-reduced-motion при этом остаётся в силе: если пользователь
 * попросил меньше движения в ОС, мы его не пере включаем обратно.
 */
export function vfxSetReducedMotion(on: boolean): void {
  reducedMotion = on || systemReducedMotion;
}

/** 2D-контекст или null — без исключений и без «not implemented» в headless. */
function safeCtx(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
  if (typeof c.getContext !== 'function') return null;
  try {
    const prev = console.error;
    console.error = (): void => { /* jsdom пишет сюда «Not implemented» — глушим */ };
    try { return c.getContext('2d') as CanvasRenderingContext2D | null; }
    finally { console.error = prev; }
  } catch { return null; }
}

function resizeCanvas(): void {
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** Центр DOM-элемента в координатах viewport. */
export function centerOf(node: Element | null | undefined, fallbackY = 0.5): Pt {
  if (!node) return { x: window.innerWidth / 2, y: window.innerHeight * fallbackY };
  const r = node.getBoundingClientRect();
  if (!r.width && !r.height) return { x: window.innerWidth / 2, y: window.innerHeight * fallbackY };
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function add(cls: string, color: VfxColor, extra: Partial<CSSStyleDeclaration> = {}): HTMLElement {
  const n = document.createElement('div');
  n.className = cls;
  n.style.color = color;
  for (const k of Object.keys(extra) as (keyof CSSStyleDeclaration)[]) {
    (n.style as unknown as Record<string, string>)[k as string] = String(extra[k]);
  }
  (layer ?? document.body).appendChild(n);
  return n;
}

function go(node: HTMLElement, life: number): void {
  void node.offsetWidth;
  node.classList.add('go');
  setTimeout(() => node.remove(), life);
}

/* =====================================================================
   Камера: тряска, hit-stop, вспышки
   ===================================================================== */

let shakeTimer: number | null = null;
let shakeEnd = 0;
let shakePower = 0;
let shakeDx = 0;
let shakeDy = 0;

/**
 * Тряска экрана. dir в градусах: 0 = вправо, 90 = вниз.
 * В Unity → CameraRig.Punch + DOTween Shake.
 */
export function shake(power = 6, dirDeg?: number, duration = 260): void {
  if (reducedMotion || !shakeRoot) return;
  shakePower = Math.max(shakePower, power);
  const a = (dirDeg ?? rnd(0, 360)) * Math.PI / 180;
  shakeDx = Math.cos(a); shakeDy = Math.sin(a);
  shakeEnd = Math.max(shakeEnd, performance.now() + duration);
  if (shakeTimer !== null) return;
  const root = shakeRoot;
  const step = (): void => {
    const now = performance.now();
    if (now >= shakeEnd) {
      root.style.transform = '';
      shakeTimer = null; shakePower = 0;
      return;
    }
    const left = (shakeEnd - now) / duration;
    const amp = shakePower * Math.min(1, left * 1.6);
    const jx = rnd(-1, 1) * amp * 0.7 + shakeDx * amp * 0.5;
    const jy = rnd(-1, 1) * amp * 0.7 + shakeDy * amp * 0.5;
    const rot = rnd(-1, 1) * amp * 0.05;
    root.style.transform = `translate3d(${jx.toFixed(2)}px,${jy.toFixed(2)}px,0) rotate(${rot.toFixed(3)}deg)`;
    shakeTimer = window.setTimeout(step, 16);
  };
  step();
}

/** Короткая пауза «веса удара» (hit-stop). В Unity → Time.timeScale. */
export async function hitStop(ms = 60): Promise<void> {
  if (reducedMotion) return;
  await sleep(ms);
}

/** Полноэкранная вспышка. В Unity → Volume: post-exposure kick или квад. */
export function screenFlash(color = '#fff3d0', alpha = 0.34, duration = 260): void {
  if (reducedMotion) return;
  const n = add('vfx-flash', color, { ['--d' as string]: duration + 'ms', ['--a' as string]: String(alpha) });
  go(n, duration + 40);
}

/** Всплеск виньетки (урон герою). В Unity → Volume: Vignette intensity kick. */
export function vignettePulse(color = '#d64545', alpha = 0.6): void {
  if (reducedMotion) return;
  const n = add('vfx-vigpulse', color, { ['--a' as string]: String(alpha) });
  go(n, 540);
}

/** Хроматическая аберрация/глитч на корне (заклинания Хаоса, тяжёлый урон). */
export async function glitch(target?: HTMLElement | null, ms = 320): Promise<void> {
  const t = target ?? shakeRoot;
  if (!t || reducedMotion) return;
  const prev = t.style.filter;
  t.style.filter = 'url(#vfxAberr)';
  t.classList.add('vfx-glitch');
  await sleep(ms);
  t.classList.remove('vfx-glitch');
  t.style.filter = prev || '';
}

/* =====================================================================
   Точечные эффекты
   ===================================================================== */

/** Расходящееся кольцо удара. Unity → VFX_ImpactRing. */
export function impactRing(at: Pt, color = '#ffd08a', size = 130): void {
  if (reducedMotion) return;
  const n = add('vfx-ring', color, { left: at.x + 'px', top: at.y + 'px', width: size + 'px', height: size + 'px' });
  go(n, 600);
}

/** Искры во все стороны. Unity → Particle System burst. */
export function sparkBurst(at: Pt, color = '#ffb066', count = 16, speed = 120): void {
  if (reducedMotion) return;
  const n = Math.max(4, Math.round(count * (reducedMotion ? 0.3 : 1)));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd(-0.25, 0.25);
    const d = rnd(speed * 0.45, speed);
    const s = add('vfx-spark', color, {
      left: at.x + 'px', top: at.y + 'px',
      ['--dx' as string]: (Math.cos(a) * d).toFixed(1) + 'px',
      ['--dy' as string]: (Math.sin(a) * d).toFixed(1) + 'px',
      ['--d' as string]: rnd(0.45, 0.9).toFixed(2) + 's',
      width: rnd(2.5, 5.5).toFixed(1) + 'px', height: rnd(2.5, 5.5).toFixed(1) + 'px',
    });
    go(s, 1000);
  }
}

/** След от клинка/когтя. Unity → quad + All In 1 Sprite. */
/** Световой след от атакующего к цели (transform/opacity only). Unity → Trail Renderer. */
export function streak(from: Pt, to: Pt, color = '#fff1cf', ms = 260): void {
  if (reducedMotion) return;
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 6) return;
  const ang = Math.atan2(dy, dx) * 180 / Math.PI;
  const n = add('vfx-streak', color, {
    left: from.x + 'px', top: from.y + 'px', width: len.toFixed(1) + 'px', height: '3px',
    marginTop: '-1.5px', transformOrigin: '0 50%', borderRadius: '2px', filter: 'blur(.4px)',
    background: `linear-gradient(90deg,transparent,${color},transparent)`,
  });
  n.animate([
    { transform: `rotate(${ang}deg) scaleX(0)`, opacity: .95 },
    { transform: `rotate(${ang}deg) scaleX(1)`, opacity: .85, offset: .45 },
    { transform: `rotate(${ang}deg) scaleX(1)`, opacity: 0 },
  ], { duration: ms, easing: 'cubic-bezier(.3,.7,.2,1)' }).onfinish = () => n.remove();
}

export function slash(at: Pt, color = '#fff1cf', angleDeg = -22, size = 120): void {
  if (reducedMotion) return;
  const svg = `<svg width="${size}" height="${size * 0.6}" viewBox="0 0 100 60">
    <path d="M4 44 C26 8, 62 4, 97 12 C66 20, 34 34, 8 54 Z" fill="currentColor" opacity=".95"/>
    <path d="M10 48 C32 18, 64 12, 94 18" stroke="#fff" stroke-width="1.6" fill="none" opacity=".75"/>
  </svg>`;
  const n = add('vfx-slash', color, { left: at.x + 'px', top: at.y + 'px', ['--a' as string]: angleDeg + 'deg' });
  n.innerHTML = svg;
  go(n, 380);
}

/** Столп света (руна, призыв). Unity → Action RPG FX beam. */
export function pillar(at: Pt, color = '#ffd98a', height = 260, width = 60): void {
  if (reducedMotion) return;
  const n = add('vfx-pillar', color, {
    left: at.x + 'px', top: (at.y - height * 0.55) + 'px', width: width + 'px', height: height + 'px',
  });
  go(n, 1000);
  impactRing(at, color, width * 2.1);
}

/** Поднимающиеся «светлячки» (лечение, мана). Unity → BG Particle Effects. */
export function motes(at: Pt, color = '#7fe0a0', count = 14, spread = 90): void {
  if (reducedMotion) return;
  for (let i = 0; i < count; i++) {
    const n = add('vfx-mote', color, {
      left: (at.x + rnd(-spread / 2, spread / 2)) + 'px',
      top: (at.y + rnd(-14, 20)) + 'px',
      width: rnd(3, 7).toFixed(1) + 'px', height: rnd(3, 7).toFixed(1) + 'px',
      ['--dy' as string]: rnd(-120, -60).toFixed(0) + 'px',
      ['--d' as string]: rnd(0.9, 1.7).toFixed(2) + 's',
    });
    setTimeout(() => go(n, 1800), i * 42);
  }
}

/** Наземная декаль (круг призыва, ритуал, прицел). Unity → Decal Projector. */
export function groundDecal(at: Pt, color = '#d8b45a', size = 150, life = 1400, glyph = true): void {
  if (reducedMotion) return;
  const n = add('vfx-decal', color, { left: at.x + 'px', top: at.y + 'px', ['--life' as string]: life + 'ms' });
  const inner = glyph
    ? `<svg width="${size}" height="${size}" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".85"/>
        <circle cx="50" cy="50" r="36" fill="none" stroke="currentColor" stroke-width=".6" opacity=".55" stroke-dasharray="4 3"/>
        <circle cx="50" cy="50" r="24" fill="currentColor" opacity=".10"/>
        <path d="M50 8 L58 42 L92 50 L58 58 L50 92 L42 58 L8 50 L42 42 Z" fill="none" stroke="currentColor" stroke-width=".9" opacity=".7"/>
      </svg>`
    : `<svg width="${size}" height="${size}"><circle cx="50%" cy="50%" r="46%" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
  n.innerHTML = `<div style="width:${size}px;height:${size}px">${inner}</div>`;
  void n.offsetWidth;
  setTimeout(() => n.remove(), life + 60);
}

/** Рябь (вода, Эхо). Unity → VFX_Ripple. */
export function ripple(at: Pt, color = '#9fe8dd', rings = 3, size = 120): void {
  if (reducedMotion) return;
  for (let i = 0; i < rings; i++) {
    setTimeout(() => impactRing(at, color, size * (1 - i * 0.22)), i * 110);
  }
}

/** Дымовое кольцо смерти. */
export function smokeRing(at: Pt, color = '#5b5468', size = 120): void {
  if (reducedMotion) return;
  const n = add('vfx-smoke', color, { left: at.x + 'px', top: at.y + 'px', width: size + 'px', height: size + 'px' });
  go(n, 900);
}

/**
 * «Душа» летит по дуге от трупа к герою (Кровавая жатва, вампиризм).
 * Unity → DOTween-путь + Trail.
 */
export async function wisp(from: Pt, to: Pt, color = '#d64545', duration = 520): Promise<void> {
  if (reducedMotion || typeof requestAnimationFrame !== 'function') return;
  const n = add('vfx-wisp', color, { left: from.x + 'px', top: from.y + 'px' });
  const bow = rnd(-90, -140);
  const t0 = performance.now();
  await new Promise<void>(res => {
    const step = (): void => {
      const k = Math.min(1, (performance.now() - t0) / duration);
      const e = 1 - Math.pow(1 - k, 2.2);
      const x = from.x + (to.x - from.x) * e;
      const y = from.y + (to.y - from.y) * e + Math.sin(Math.PI * k) * bow;
      n.style.left = x + 'px'; n.style.top = y + 'px';
      n.style.opacity = String(k < 0.85 ? 0.95 : (1 - k) / 0.15);
      n.style.transform = `translate(-50%,-50%) scale(${(1.25 - k * 0.55).toFixed(2)})`;
      if (k < 1) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
  n.remove();
}

/**
 * Снаряд заклинания с трейлом. Unity → DOTween-путь + Trail Renderer.
 * Возвращает промис, который разрешается в момент попадания.
 */
export async function projectile(from: Pt, to: Pt, color = '#ff7a18', speed = 1500, opts: { lob?: number } = {}): Promise<void> {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = Math.max(120, (dist / speed) * 1000);
  if (reducedMotion || typeof requestAnimationFrame !== 'function') { await sleep(Math.min(160, duration * 0.3)); return; }
  const head = add('vfx-proj', color, { left: from.x + 'px', top: from.y + 'px' });
  const trail = add('vfx-trail', color, { left: from.x + 'px', top: from.y + 'px', width: '10px' });
  const lob = opts.lob ?? Math.min(70, dist * 0.18);
  const t0 = performance.now();
  await new Promise<void>(res => {
    const step = (): void => {
      const k = Math.min(1, (performance.now() - t0) / duration);
      const e = k * k * (3 - 2 * k);                        // smoothstep
      const x = from.x + (to.x - from.x) * e;
      const y = from.y + (to.y - from.y) * e - Math.sin(Math.PI * k) * lob;
      head.style.left = x + 'px'; head.style.top = y + 'px';
      const ang = Math.atan2(y - from.y, x - from.x) * 180 / Math.PI;
      const len = Math.min(120, 18 + dist * 0.22 * (1 - Math.abs(k - 0.5)));
      trail.style.left = x + 'px'; trail.style.top = y + 'px';
      trail.style.width = len + 'px';
      trail.style.transform = `rotate(${ang + 180}deg)`;
      if (k < 1) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
  head.remove();
  trail.animate?.([{ opacity: 0.85 }, { opacity: 0 }], { duration: 160 });
  setTimeout(() => trail.remove(), 180);
}

/** Тепловое марево над целью (Огонь). Unity → distortion-шейдер. */
export function heatHaze(at: Pt, color = '#ff7a18', size = 130, ms = 900): void {
  if (reducedMotion) return;
  const n = add('vfx-haze', color, {
    left: at.x + 'px', top: at.y + 'px', width: size + 'px', height: size + 'px', transform: 'translate(-50%,-50%)',
  });
  setTimeout(() => { n.animate([{ opacity: 0.35 }, { opacity: 0 }], { duration: 300 }); }, ms - 300);
  setTimeout(() => n.remove(), ms + 40);
}

/** Растворение DOM-узла (смерть существа, сгорание карты). Unity → radial dissolve. */
export function dissolve(node: HTMLElement, ms = 620): void {
  node.classList.add('vfx-dissolve');
  setTimeout(() => node.remove(), ms + 40);
}

/* =====================================================================
   Составные сцены (то, что вызывает контроллер боя)
   ===================================================================== */

/** Удар существа в ближнем бою. */
export async function meleeImpact(at: Pt, dirDeg: number, power = 1): Promise<void> {
  slash(at, '#fff1cf', dirDeg > 0 ? 24 : -24, 100 + power * 40);
  sparkBurst(at, '#ffd08a', 10 + Math.round(power * 8), 90 + power * 50);
  impactRing(at, '#ffb066', 90 + power * 40);
  shake(4 + power * 4, dirDeg, 220);
  await hitStop(50 + power * 25);
}

/** Попадание заклинания по цели. */
export async function spellImpact(at: Pt, element: string, power = 1): Promise<void> {
  const color = ELEMENT_VFX[element] ?? ELEMENT_VFX.None;
  if (element === 'Fire') {
    sparkBurst(at, color, 22, 150 * power);
    impactRing(at, '#ffd08a', 150 * power);
    heatHaze(at, color, 150, 700);
    shake(6 * power, rnd(-40, -140), 260);
  } else if (element === 'Water' || element === 'Air') {
    ripple(at, color, 3, 150 * power);
    sparkBurst(at, color, 14, 110 * power);
    shake(3 * power, 90, 200);
  } else if (element === 'Earth') {
    groundDecal(at, '#8a7a52', 170 * power, 1200, false);
    sparkBurst(at, '#c8b48a', 20, 130 * power);
    shake(9 * power, 90, 320);
  } else if (element === 'Chaos') {
    await glitch(null, 300);
    sparkBurst(at, color, 20, 140 * power);
  } else {
    impactRing(at, color, 140 * power);
    sparkBurst(at, color, 16, 120 * power);
    shake(4 * power, rnd(0, 360), 220);
  }
  screenFlash(color, 0.16, 220);
}

/** Смерть существа: дизсолв + дым + душа к герою владельца. */
export function deathFx(at: Pt, heroAt: Pt, factionColor = '#a855c9'): void {
  smokeRing(at, '#4b4457', 130);
  sparkBurst(at, factionColor, 14, 100);
  impactRing(at, '#8d8498', 110);
  void wisp(at, heroAt, factionColor, 560);
  shake(3, 90, 180);
}

/** Лечение. */
export function healFx(at: Pt): void {
  motes(at, '#7fe0a0', 16, 100);
  impactRing(at, '#7fe0a0', 110);
}

/** Щит поглотил урон. */
export function shieldFx(at: Pt): void {
  impactRing(at, '#a9dcff', 120);
  sparkBurst(at, '#dff0ff', 12, 80);
  screenFlash('#cfe8ff', 0.14, 180);
}

/** Урон герою: тяжёлая обратная связь. */
export function heroDamageFx(side: 'player' | 'enemy', amount: number): void {
  const color = side === 'player' ? '#d64545' : '#ffb066';
  vignettePulse(side === 'player' ? '#d64545' : '#7a3a12', Math.min(0.85, 0.3 + amount * 0.05));
  shake(Math.min(16, 5 + amount * 0.9), side === 'player' ? 0 : 180, 300);
  if (amount >= 6) void glitch(null, 240);
  void color;
}

/** Постановка руны: столп + кольцо глифов. */
export function runeFx(at: Pt, color = '#d8b45a'): void {
  pillar(at, color, 300, 64);
  groundDecal(at, color, 170, 2200, true);
  motes(at, color, 14, 80);
}

/** Призыв существа: проявляющийся сигил вместо обычного «падения» карты на поле. */
export function summonFx(at: Pt, color = '#d8b45a'): void {
  if (reducedMotion) return;
  const size = 176;
  const sigil = add('vfx-summon-sigil', color, {
    left: `${at.x}px`, top: `${at.y}px`, width: `${size}px`, height: `${size}px`,
  });
  sigil.setAttribute('aria-hidden', 'true');
  sigil.innerHTML = `<svg viewBox="0 0 128 128" focusable="false">
    <circle cx="64" cy="64" r="54" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".92"/>
    <circle class="orbit" cx="64" cy="64" r="45" fill="none" stroke="currentColor" stroke-width="1" opacity=".78"/>
    <circle cx="64" cy="64" r="31" fill="currentColor" opacity=".10"/>
    <path d="M64 10 70 48 108 64 70 70 64 108 58 70 20 64 58 58Z" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".9"/>
    <path d="M64 28 75 53 100 64 75 75 64 100 53 75 28 64 53 53Z" fill="none" stroke="currentColor" stroke-width=".9" opacity=".7"/>
    <path class="etch" d="M42 23 48 34 39 41M86 23 80 34 89 41M105 42 94 48 87 39M105 86 94 80 87 89M42 105 48 94 39 87M23 86 34 80 41 89M23 42 34 48 41 39M86 105 80 94 89 87" fill="none" stroke="currentColor" stroke-width="1.1"/>
    <path d="M64 46 68 60 82 64 68 68 64 82 60 68 46 64 60 60Z" fill="currentColor" opacity=".62"/>
    <circle cx="64" cy="10" r="2" fill="currentColor"/><circle cx="118" cy="64" r="2" fill="currentColor"/>
    <circle cx="64" cy="118" r="2" fill="currentColor"/><circle cx="10" cy="64" r="2" fill="currentColor"/>
  </svg>`;
  go(sigil, 820);
  groundDecal(at, color, 132, 1050, true);
  impactRing(at, color, 136);
  sparkBurst(at, color, 16, 94);
}

/** Эхо: фиолетовая рябь и призрачный след. */
export function echoFx(at: Pt): void {
  ripple(at, '#b06cf0', 4, 170);
  motes(at, '#e0c6ff', 18, 120);
  screenFlash('#b06cf0', 0.18, 300);
}

/** Фаза: лёгкий акцент (баннер фазы). */
export function phaseFx(phase: string): void {
  if (phase === 'Combat') { screenFlash('#ff9a4a', 0.12, 260); shake(3, 0, 180); }
  else if (phase === 'Resource') { motes({ x: window.innerWidth * 0.5, y: window.innerHeight * 0.55 }, '#4f8fe0', 10, 200); }
  else if (phase === 'End') { screenFlash('#b06cf0', 0.08, 240); }
}

/* =====================================================================
   Ambient: частицы фона (Canvas) + параллакс
   ===================================================================== */

interface AmbientParticle { x: number; y: number; vx: number; vy: number; r: number; a: number; hue: VfxColor; tw: number }

let ambient: AmbientParticle[] = [];
let ambientColor: VfxColor = '#d8b45a';
let parallaxLayers: HTMLElement[] = [];
let parallaxTarget = { x: 0, y: 0 };
let parallaxCur = { x: 0, y: 0 };

/** Запуск фонового слоя частиц. Цвет = палитра фракции игрока. */
export function startAmbient(color: VfxColor, count = 70): void {
  ambientColor = color;
  if (ambientRunning) { setAmbientColor(color); return; }
  if (!ctx || typeof requestAnimationFrame !== 'function') return;   // нет canvas → молча пропускаем
  ambientRunning = true;
  const w = window.innerWidth, h = window.innerHeight;
  for (let i = 0; i < count; i++) {
    ambient.push({
      x: rnd(0, w), y: rnd(0, h),
      vx: rnd(-0.14, 0.14), vy: rnd(-0.30, -0.05),
      r: rnd(0.6, 2.4), a: rnd(0.10, 0.42),
      hue: color, tw: rnd(0.4, 2.2),
    });
  }
  requestAnimationFrame(ambientFrame);
}

function ambientFrame(t: number): void {
  if (!ambientRunning || !ctx || !canvas) return;
  const w = window.innerWidth, h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);
  for (const p of ambient) {
    p.x += p.vx + Math.sin((t / 2600) + p.tw) * 0.16;
    p.y += p.vy;
    if (p.y < -12) { p.y = h + 10; p.x = rnd(0, w); }
    if (p.x < -12) p.x = w + 10;
    if (p.x > w + 12) p.x = -10;
    const tw = 0.55 + 0.45 * Math.sin(t / 620 * p.tw + p.x * 0.01);
    ctx.globalAlpha = p.a * tw;
    ctx.fillStyle = p.hue;
    ctx.shadowBlur = 10; ctx.shadowColor = p.hue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  requestAnimationFrame(ambientFrame);
}

export function setAmbientColor(color: VfxColor): void {
  ambientColor = color;
  for (const p of ambient) p.hue = color;
}

export function stopAmbient(): void {
  ambientRunning = false;
  ambient = [];
  if (ctx && canvas) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
}

/**
 * Параллакс: слои фона двигаются за курсором с разной силой.
 * layers — от дальнего к ближнему; множитель глубины растёт.
 */
export function startParallax(layers: HTMLElement[]): void {
  parallaxLayers = layers;
  if (reducedMotion || layers.length === 0) return;
  window.addEventListener('pointermove', (ev: PointerEvent) => {
    parallaxTarget.x = (ev.clientX / window.innerWidth - 0.5) * 2;
    parallaxTarget.y = (ev.clientY / window.innerHeight - 0.5) * 2;
  });
  requestAnimationFrame(parallaxFrame);
}

function parallaxFrame(): void {
  parallaxCur.x += (parallaxTarget.x - parallaxCur.x) * 0.055;
  parallaxCur.y += (parallaxTarget.y - parallaxCur.y) * 0.055;
  parallaxLayers.forEach((l, i) => {
    const depth = (i + 1) * 7;
    l.style.transform = `translate3d(${(-parallaxCur.x * depth).toFixed(2)}px, ${(-parallaxCur.y * depth * 0.6).toFixed(2)}px, 0) scale(${(1.06 + i * 0.005).toFixed(3)})`;
  });
  requestAnimationFrame(parallaxFrame);
}

/** Плёночное зерно + виньетка (пост-слои). Вызывается один раз при старте боя. */
export function mountPostLayers(host: HTMLElement): void {
  if (host.querySelector('#postVignette')) return;
  /* v3.16.1: виньетка значительно мягче (чёткая видимость поля по краям),
     плёночное зерно (jitter-мерцание noise поверх всего экрана, z-index 111)
     убрано — пользователь видел его как «прыгающий фон». */
  const vig = document.createElement('div');
  vig.id = 'postVignette';
  vig.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:110;' +
    'background:radial-gradient(ellipse at 50% 46%, transparent 58%, rgba(5,6,10,.22) 100%);mix-blend-mode:multiply';
  const grade = document.createElement('div');
  grade.id = 'postGrade';
  grade.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:109;' +
    'background:linear-gradient(180deg, rgba(42,36,56,.30) 0%, rgba(0,0,0,0) 38%, rgba(216,180,90,.07) 100%);' +
    'mix-blend-mode:soft-light';
  host.appendChild(grade); host.appendChild(vig);
}

/** Случайный «блик» свечей: короткая вспышка ambient-света. */
export function candleFlicker(host: HTMLElement): void {
  if (reducedMotion || !host) return;
  const n = document.createElement('div');
  n.style.cssText = 'position:absolute;inset:0;pointer-events:none;mix-blend-mode:screen;' +
    `background:radial-gradient(ellipse at ${rnd(18, 82)}% ${rnd(12, 42)}%, ${ambientColor}33 0%, transparent 55%)`;
  host.appendChild(n);
  n.animate?.([{ opacity: 0 }, { opacity: 0.85 }, { opacity: 0 }], { duration: rnd(700, 1500) });
  setTimeout(() => n.remove(), 1600);
}

export const Vfx = {
  shake, hitStop, screenFlash, vignettePulse, glitch,
  impactRing, sparkBurst, slash, pillar, motes, groundDecal, ripple,
  smokeRing, wisp, projectile, heatHaze, dissolve,
  meleeImpact, spellImpact, deathFx, healFx, shieldFx, heroDamageFx, runeFx, summonFx, echoFx, phaseFx,
  startAmbient, setAmbientColor, stopAmbient, startParallax, mountPostLayers, candleFlicker, centerOf,
};
export { pick as vfxPick };
