/* =====================================================================
   ЭХО-ЦИТАДЕЛЬ — звук прототипа (src/ui/audio.ts)
   ---------------------------------------------------------------------
   Полностью синтезированный WebAudio: ни одного внешнего файла, поэтому
   прототип остаётся самодостаточным (открывается как file:// и в
   sandboxed-превью). В ТЗ звук не заявлен → модуль необязательный и
   выключается одной кнопкой; на логику игры не влияет.

   В Unity этот набор превращается в список клипов для AudioSource:
     cardTake / cardSlide / cardPlay / summon / melee / spell{Fire,Water,
     Earth,Air,Chaos} / shield / death / heal / echo / rune / ritual /
     phaseCombat / heroHit / victory / defeat / uiClick / uiHover
   ===================================================================== */

let ac: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let enabled = true;
let unlocked = false;

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

/*
 * Создаёт AudioContext лениво. Возвращает null, если Web Audio недоступен
 * (например, в headless-тестах на jsdom) — тогда звук просто молча отключается,
 * игра продолжает работать.
 */
function ctxNow(): AudioContext | null {
  if (ac) return ac;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) { enabled = false; return null; }
  try {
    ac = new Ctor();
    master = ac.createGain();
    master.gain.value = 0.5;
    master.connect(ac.destination);
  } catch { enabled = false; return null; }
  return ac;
}

/** Браузеры требуют жест пользователя: вызываем на первом клике. */
export function audioUnlock(): void {
  if (unlocked) return;
  unlocked = true;
  const c = ctxNow();
  if (c && c.state === 'suspended') void c.resume();
}

let sfxVol = 1;
let musicVol = 0.6;
let musicGain: GainNode | null = null;
const musicNodes: OscillatorNode[] = [];

export function audioSetEnabled(v: boolean): void {
  enabled = v;
  if (master) master.gain.value = v ? 0.5 * sfxVol : 0;
}
export function audioIsEnabled(): boolean { return enabled; }

/** Громкость эффектов 0..1 (настройки доступности/комфорта). */
export function audioSetVolume(v: number): void {
  sfxVol = Math.max(0, Math.min(1, v));
  if (master && enabled) master.gain.value = 0.5 * sfxVol;
}

/** Фоновая музыка: мягкий эмбиент-дрон из трёх синусов + медленный LFO. */
export function musicStart(): void {
  const c = ctxNow();
  if (!c) return;
  if (!musicGain) {
    musicGain = c.createGain();
    musicGain.gain.value = 0.05 * musicVol;
    musicGain.connect(master ?? c.destination);
    for (const [f, g0] of [[110, 0.6], [164.81, 0.25], [220, 0.18]] as Array<[number, number]>) {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = c.createGain(); g.gain.value = g0;
      o.connect(g); g.connect(musicGain); o.start(); musicNodes.push(o);
    }
    const lfo = c.createOscillator(); lfo.frequency.value = 0.07;
    const lg = c.createGain(); lg.gain.value = 0.02;
    lfo.connect(lg); lg.connect(musicGain.gain); lfo.start(); musicNodes.push(lfo);
  }
  musicGain.gain.value = 0.05 * musicVol * (enabled ? 1 : 0);
}

/** Громкость музыки 0..1; при первом повышении — запускает дрону. */
export function musicSetVolume(v: number): void {
  musicVol = Math.max(0, Math.min(1, v));
  if (!musicGain && musicVol > 0 && unlocked) musicStart();
  if (musicGain) musicGain.gain.value = 0.05 * musicVol * (enabled ? 1 : 0);
}

function noise(c: AudioContext): AudioBufferSourceNode {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 1.2), c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = c.createBufferSource();
  s.buffer = noiseBuf;
  s.loop = true;
  return s;
}

interface ToneOpts { freq: number; to?: number; dur: number; type?: OscillatorType; gain?: number; delay?: number; curve?: number }

function tone(o: ToneOpts): void {
  if (!enabled) return;
  const c = ctxNow();
  if (!c || !master) return;
  const t0 = c.currentTime + (o.delay ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t0 + o.dur);
  const peak = o.gain ?? 0.22;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, o.dur * 0.18));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  osc.connect(g); g.connect(master);
  osc.start(t0); osc.stop(t0 + o.dur + 0.03);
}

interface NoiseOpts { dur: number; gain?: number; type?: BiquadFilterType; freq?: number; to?: number; delay?: number; q?: number }

function hit(o: NoiseOpts): void {
  if (!enabled) return;
  const c = ctxNow();
  if (!c || !master) return;
  const t0 = c.currentTime + (o.delay ?? 0);
  const src = noise(c);
  const f = c.createBiquadFilter();
  f.type = o.type ?? 'lowpass';
  f.frequency.setValueAtTime(o.freq ?? 1400, t0);
  if (o.to) f.frequency.exponentialRampToValueAtTime(Math.max(60, o.to), t0 + o.dur);
  f.Q.value = o.q ?? 0.9;
  const g = c.createGain();
  const peak = o.gain ?? 0.2;
  g.gain.setValueAtTime(peak, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t0); src.stop(t0 + o.dur + 0.03);
}

/* ------------------------------------------------------------------ */
/*  Публичные звуки                                                    */
/* ------------------------------------------------------------------ */

export const Audio_ = {
  /** Клик по кнопке/карте в меню. */
  uiClick(): void { tone({ freq: 620, to: 880, dur: 0.05, type: 'triangle', gain: 0.08 }); },
  /** Наведение на карту. */
  uiHover(): void { tone({ freq: 1180, dur: 0.035, type: 'sine', gain: 0.035 }); },
  /** Смена фракции в меню: воздушный «вжух» (свип полосового шума). */
  whoosh(): void {
    hit({ dur: 0.42, gain: 0.1, type: 'bandpass', freq: 420, to: 2800, q: 0.9 });
    tone({ freq: 220, to: 660, dur: 0.3, type: 'sine', gain: 0.045, delay: 0.02 });
  },
  /** Уровень повышен: восходящая терцовая триада + блеск (спека «2. Профиль» п.2.1). */
  levelUp(): void {
    tone({ freq: 330, to: 660, dur: 0.22, type: 'triangle', gain: 0.14 });
    tone({ freq: 495, to: 990, dur: 0.26, type: 'sine', gain: 0.1, delay: 0.1 });
    tone({ freq: 660, to: 1320, dur: 0.34, type: 'triangle', gain: 0.12, delay: 0.2 });
    hit({ dur: 0.4, gain: 0.08, type: 'highpass', freq: 2600, to: 5200, delay: 0.22 });
  },
  /** Достижение разблокировано: фанфара + тёплый удар. */
  achievement(): void {
    tone({ freq: 392, to: 784, dur: 0.3, type: 'triangle', gain: 0.15 });
    tone({ freq: 587, to: 1175, dur: 0.34, type: 'sine', gain: 0.11, delay: 0.12 });
    hit({ dur: 0.3, gain: 0.1, type: 'lowpass', freq: 2400, to: 500, delay: 0.02 });
  },

  /** Добор карты: шорох. */
  cardTake(): void { hit({ dur: 0.13, gain: 0.11, type: 'highpass', freq: 2400, to: 1200 }); },
  /** Перетаскивание карты. */
  cardSlide(): void { hit({ dur: 0.2, gain: 0.07, type: 'bandpass', freq: 900, to: 1800, q: 1.4 }); },
  /** Карта сыграна: короткий «щелчок» рамки + тон. */
  cardPlay(cost = 3): void {
    tone({ freq: 220 + cost * 26, to: 320 + cost * 30, dur: 0.16, type: 'triangle', gain: 0.16 });
    hit({ dur: 0.09, gain: 0.09, type: 'highpass', freq: 3000 });
  },

  /** Призыв существа: восходящий аккорд + вспышка. */
  summon(): void {
    tone({ freq: 180, to: 360, dur: 0.3, type: 'sine', gain: 0.18 });
    tone({ freq: 360, to: 720, dur: 0.26, type: 'triangle', gain: 0.09, delay: 0.05 });
    hit({ dur: 0.24, gain: 0.1, type: 'lowpass', freq: 2200, to: 400, delay: 0.02 });
  },

  /** Удар существа в ближнем бою. */
  melee(power = 1): void {
    tone({ freq: 130, to: 62, dur: 0.16, type: 'square', gain: clamp(0.1 * power, 0.05, 0.22) });
    hit({ dur: 0.13, gain: clamp(0.2 * power, 0.08, 0.32), type: 'lowpass', freq: 1800, to: 260 });
  },

  /** Заклинание по стихии. */
  spell(element: string, cost = 3): void {
    const p = clamp(0.6 + cost * 0.09, 0.6, 1.6);
    switch (element) {
      case 'Fire':
        hit({ dur: 0.42 * p, gain: 0.2, type: 'lowpass', freq: 2600, to: 220 });
        tone({ freq: 90, to: 44, dur: 0.34 * p, type: 'sawtooth', gain: 0.13 });
        break;
      case 'Water':
        tone({ freq: 880, to: 320, dur: 0.4 * p, type: 'sine', gain: 0.14 });
        hit({ dur: 0.3 * p, gain: 0.07, type: 'bandpass', freq: 1200, to: 500, q: 2 });
        break;
      case 'Earth':
        tone({ freq: 74, to: 40, dur: 0.4 * p, type: 'square', gain: 0.2 });
        hit({ dur: 0.34 * p, gain: 0.16, type: 'lowpass', freq: 700, to: 120 });
        break;
      case 'Air':
        hit({ dur: 0.44 * p, gain: 0.12, type: 'highpass', freq: 1800, to: 5200 });
        tone({ freq: 1400, to: 2600, dur: 0.24 * p, type: 'sine', gain: 0.06 });
        break;
      case 'Chaos':
        tone({ freq: 420, to: 1180, dur: 0.3 * p, type: 'sawtooth', gain: 0.1 });
        tone({ freq: 430, to: 90, dur: 0.34 * p, type: 'square', gain: 0.09, delay: 0.03 });
        hit({ dur: 0.22, gain: 0.08, type: 'bandpass', freq: 2400, to: 300, q: 6 });
        break;
      default:
        tone({ freq: 520, to: 780, dur: 0.26 * p, type: 'triangle', gain: 0.13 });
        hit({ dur: 0.16, gain: 0.07, type: 'highpass', freq: 2600 });
    }
  },

  /** Щит поглотил урон: стеклянный «пинг». */
  shield(): void {
    tone({ freq: 1560, to: 1180, dur: 0.28, type: 'sine', gain: 0.13 });
    tone({ freq: 2340, dur: 0.18, type: 'sine', gain: 0.06, delay: 0.02 });
    hit({ dur: 0.1, gain: 0.06, type: 'highpass', freq: 4200 });
  },

  /** Смерть существа. */
  death(): void {
    tone({ freq: 260, to: 58, dur: 0.5, type: 'sawtooth', gain: 0.13 });
    hit({ dur: 0.4, gain: 0.14, type: 'lowpass', freq: 1400, to: 160 });
  },

  /** Лечение: мягкий восходящий интервал. */
  heal(): void {
    tone({ freq: 523, dur: 0.2, type: 'sine', gain: 0.1 });
    tone({ freq: 784, dur: 0.26, type: 'sine', gain: 0.09, delay: 0.09 });
    tone({ freq: 1046, dur: 0.3, type: 'sine', gain: 0.06, delay: 0.18 });
  },

  /** Эхо: «пустой» призвук с задержкой. */
  echo(): void {
    tone({ freq: 392, to: 588, dur: 0.5, type: 'sine', gain: 0.13 });
    tone({ freq: 392, to: 588, dur: 0.44, type: 'sine', gain: 0.07, delay: 0.19 });
    tone({ freq: 784, dur: 0.4, type: 'triangle', gain: 0.04, delay: 0.34 });
  },

  /** Руна вступает в силу: низкий гул + колокол. */
  rune(): void {
    tone({ freq: 110, to: 165, dur: 0.9, type: 'sine', gain: 0.14 });
    tone({ freq: 880, to: 660, dur: 0.7, type: 'triangle', gain: 0.07, delay: 0.06 });
    hit({ dur: 0.7, gain: 0.05, type: 'bandpass', freq: 600, q: 3 });
  },

  /** Ритуал поставлен: тикающий «завод». */
  ritual(): void {
    for (let i = 0; i < 3; i++) tone({ freq: 700 + i * 180, dur: 0.07, type: 'square', gain: 0.06, delay: i * 0.11 });
    tone({ freq: 180, to: 240, dur: 0.5, type: 'sine', gain: 0.1, delay: 0.3 });
  },

  /** Начало фазы «Битва». */
  phaseCombat(): void {
    tone({ freq: 82, to: 62, dur: 0.5, type: 'sawtooth', gain: 0.16 });
    hit({ dur: 0.42, gain: 0.13, type: 'lowpass', freq: 900, to: 140 });
  },

  /** Урон герою. */
  heroHit(amount = 3): void {
    tone({ freq: 150, to: 60, dur: 0.3, type: 'square', gain: clamp(0.08 + amount * 0.014, 0.08, 0.24) });
    hit({ dur: 0.28, gain: 0.18, type: 'lowpass', freq: 1200, to: 180 });
  },

  /** Усталость: пустая колода. */
  fatigue(): void {
    tone({ freq: 300, to: 90, dur: 0.6, type: 'sine', gain: 0.1 });
    hit({ dur: 0.5, gain: 0.07, type: 'lowpass', freq: 800, to: 120 });
  },

  /** Победа: мажорный аккорд. */
  victory(): void {
    [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, dur: 0.7, type: 'triangle', gain: 0.12, delay: i * 0.1 }));
  },

  /** Поражение: минорный спад. */
  defeat(): void {
    [392, 330, 262, 196].forEach((f, i) => tone({ freq: f, to: f * 0.94, dur: 0.85, type: 'sine', gain: 0.13, delay: i * 0.16 }));
    hit({ dur: 1.1, gain: 0.07, type: 'lowpass', freq: 500, to: 90, delay: 0.2 });
  },
};

export default Audio_;
