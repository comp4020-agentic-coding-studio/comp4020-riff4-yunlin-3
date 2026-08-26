// Bamboo chimes: seven tubes tuned to a five-tone (pentatonic) scale, each one
// a small physical model rather than a sample — so no two strikes, and no two
// players, sound quite the same.

const NOTE_FREQS = [220.0, 246.94, 293.66, 329.63, 392.0, 440.0, 523.25];

let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let dryGain: GainNode | null = null;
let wetGain: GainNode | null = null;
let reverb: ConvolverNode | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createReverbImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
    }
  }
  return impulse;
}

function ensureAudio(): AudioContext {
  if (audioCtx) {
    if (audioCtx.state === "suspended") void audioCtx.resume();
    return audioCtx;
  }

  const ctx = new AudioContext();
  audioCtx = ctx;

  masterGain = ctx.createGain();
  masterGain.gain.value = 0.85;
  masterGain.connect(ctx.destination);

  dryGain = ctx.createGain();
  dryGain.gain.value = 0.75;
  dryGain.connect(masterGain);

  wetGain = ctx.createGain();
  wetGain.gain.value = 0.4;
  reverb = ctx.createConvolver();
  reverb.buffer = createReverbImpulse(ctx, 2.4, 2.5);
  reverb.connect(wetGain);
  wetGain.connect(masterGain);

  return ctx;
}

function strike(noteIndex: number, pan: number, intensity = 1): void {
  const ctx = ensureAudio();
  const freq = NOTE_FREQS[noteIndex];
  const now = ctx.currentTime;
  const level = clamp(intensity, 0.1, 1.2);

  // Bamboo rings woodier and shorter than metal: a dry knock from the striker,
  // a breathy air-column resonance sitting on the tube's pitch, and a few
  // near-harmonic partials that die quickly. Every strike is still detuned and
  // timed slightly differently, so the same tube never rings twice identically.
  const detune = (Math.random() - 0.5) * 10;
  const decay = 0.9 + Math.random() * 0.5;

  const panner = ctx.createStereoPanner();
  panner.pan.value = clamp(pan, -1, 1);
  panner.connect(dryGain!);
  panner.connect(reverb!);

  // Air-column partials: an open tube speaks near-harmonically (2x, ~3x), and
  // the upper modes of a struck tube lose energy much faster than the
  // fundamental.
  const partials: Array<[ratio: number, gain: number, decayScale: number]> = [
    [1, 0.42, 1],
    [2.01, 0.15, 0.45],
    [3.42, 0.06, 0.2],
  ];
  for (const [ratio, gain, decayScale] of partials) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq * ratio;
    osc.detune.value = detune;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain * level, now + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0004, now + decay * decayScale);
    osc.connect(env);
    env.connect(panner);
    osc.start(now);
    osc.stop(now + decay + 0.1);
  }

  const noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.3), ctx.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;

  // The dry woody "tok" of the striker on the tube wall.
  const knock = ctx.createBufferSource();
  knock.buffer = noiseBuffer;
  const knockFilter = ctx.createBiquadFilter();
  knockFilter.type = "bandpass";
  knockFilter.frequency.value = 1400 + freq;
  knockFilter.Q.value = 1.1;
  const knockEnv = ctx.createGain();
  knockEnv.gain.setValueAtTime(0.5 * level, now);
  knockEnv.gain.exponentialRampToValueAtTime(0.0004, now + 0.045);
  knock.connect(knockFilter);
  knockFilter.connect(knockEnv);
  knockEnv.connect(panner);
  knock.start(now);

  // The hollow breath of the tube: noise rung through a resonant bandpass at
  // the tube's own pitch.
  const breath = ctx.createBufferSource();
  breath.buffer = noiseBuffer;
  const breathFilter = ctx.createBiquadFilter();
  breathFilter.type = "bandpass";
  breathFilter.frequency.value = freq;
  breathFilter.Q.value = 18;
  const breathEnv = ctx.createGain();
  breathEnv.gain.setValueAtTime(0.3 * level, now);
  breathEnv.gain.exponentialRampToValueAtTime(0.0004, now + 0.28);
  breath.connect(breathFilter);
  breathFilter.connect(breathEnv);
  breathEnv.connect(panner);
  breath.start(now);
}

function setupChimes(): void {
  const grove = document.querySelector<HTMLElement>("#grove");
  if (!grove) return;
  const chimeEls = Array.from(grove.querySelectorAll<HTMLButtonElement>(".chime"));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Each tube is a damped pendulum pivoting where its cord meets the beam.
  // Angle is radians (positive leans right), velocity rad/s; geometry is
  // viewport pixels, measured at rest and remeasured on resize/scroll — both
  // rects and pointer events use client coordinates, so they stay comparable.
  interface Tube {
    el: HTMLButtonElement;
    note: number;
    pan: number;
    pivotX: number;
    pivotY: number;
    halfWidth: number;
    length: number;
    angle: number;
    vel: number;
  }

  const tubes: Tube[] = chimeEls.map((el) => ({
    el,
    note: Number(el.dataset.note ?? "0"),
    pan: 0,
    pivotX: 0,
    pivotY: 0,
    halfWidth: 0,
    length: 0,
    angle: 0,
    vel: 0,
  }));

  function measure(): void {
    // The cord is 0.85rem (matches .chime::before / transform-origin in CSS).
    const stringPx = 0.85 * parseFloat(getComputedStyle(document.documentElement).fontSize);
    const groveRect = grove!.getBoundingClientRect();
    for (const t of tubes) {
      t.el.style.transform = "";
      const rect = t.el.getBoundingClientRect();
      t.pivotX = rect.left + rect.width / 2;
      t.pivotY = rect.top - stringPx;
      t.halfWidth = rect.width / 2;
      t.length = rect.bottom - t.pivotY;
      t.pan = ((t.pivotX - groveRect.left) / groveRect.width) * 2 - 1;
    }
    render();
  }

  function render(): void {
    if (reducedMotion) return;
    for (const t of tubes) {
      t.el.style.transform = t.angle === 0 ? "" : `rotate(${((t.angle * 180) / Math.PI).toFixed(3)}deg)`;
    }
  }

  // --- Pendulum integration -------------------------------------------------

  const GRAVITY = 3000; // px/s² — tuned for feel, not for Earth
  const DAMPING = 0.7; // 1/s
  const MAX_ANGLE = 0.5; // rad — the cord goes taut against the beam

  let rafId = 0;
  let lastFrame = 0;

  function frame(now: number): void {
    const dt = Math.min(0.02, (now - lastFrame) / 1000);
    lastFrame = now;
    let moving = false;
    for (const t of tubes) {
      t.vel += -(GRAVITY / t.length) * Math.sin(t.angle) * dt;
      t.vel *= Math.exp(-DAMPING * dt);
      t.angle += t.vel * dt;
      if (Math.abs(t.angle) > MAX_ANGLE) {
        // The cord goes taut: the jerk swallows the energy rather than
        // bouncing the tube back — it stalls at the limit and gravity brings
        // it home, instead of whipping against the direction it was thrown.
        t.angle = Math.sign(t.angle) * MAX_ANGLE;
        if (Math.sign(t.vel) === Math.sign(t.angle)) t.vel *= -0.05;
      }
      if (Math.abs(t.angle) < 0.003 && Math.abs(t.vel) < 0.02) {
        t.angle = 0;
        t.vel = 0;
      } else {
        moving = true;
      }
    }
    collide(now);
    render();
    if (moving) {
      rafId = requestAnimationFrame(frame);
    } else {
      rafId = 0;
    }
  }

  function wake(): void {
    if (rafId) return;
    lastFrame = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  // --- Tube-on-tube collisions ---------------------------------------------

  // Tube tops hang level, so a swinging pair first touches at the bottom of
  // the shorter tube. Equal-mass collision with restitution, plus positional
  // separation so they don't sink into each other; a hard enough clack rings
  // both tubes, scaled by how fast they met. Bamboo-on-bamboo is a dead thud,
  // not a billiard ball: low restitution, so one hard hit passes a couple of
  // clacks down the row and dies out instead of setting the whole grove off.
  const RESTITUTION = 0.45;
  const lastClack = new Map<number, number>();

  function collide(nowMs: number): void {
    // Iterated sequential solver: separating one pair can shove the shared
    // tube into its other neighbour, so a single pass over the pairs can end
    // the frame with tubes still drawn overlapping. Repeat until no pair
    // penetrates (a few passes always suffice for a seven-tube chain).
    for (let pass = 0; pass < 6; pass++) {
      let anyOverlap = false;
      for (let i = 0; i < tubes.length - 1; i++) {
        const a = tubes[i];
        const b = tubes[i + 1];
        const h = Math.min(a.length, b.length);
        const edgeA = a.pivotX + Math.sin(a.angle) * h + a.halfWidth;
        const edgeB = b.pivotX + Math.sin(b.angle) * h - b.halfWidth;
        const overlap = edgeA - edgeB;
        if (overlap <= 0) continue;
        anyOverlap = true;

        const push = (overlap / 2 + 0.5) / h;
        a.angle -= push;
        b.angle += push;

        const uA = a.vel * h;
        const uB = b.vel * h;
        const closing = uA - uB;
        if (closing <= 0) continue;
        a.vel = ((1 - RESTITUTION) * uA + (1 + RESTITUTION) * uB) / 2 / h;
        b.vel = ((1 + RESTITUTION) * uA + (1 - RESTITUTION) * uB) / 2 / h;

        const last = lastClack.get(i) ?? 0;
        if (closing > 140 && nowMs - last > 80) {
          lastClack.set(i, nowMs);
          const punch = 0.2 + Math.min(1, closing / 1800) * 0.5;
          strike(a.note, a.pan, punch);
          strike(b.note, b.pan, punch);
        }
      }
      if (!anyOverlap) break;
    }
  }

  // --- Striking -------------------------------------------------------------

  const lastStruck = new Map<Tube, number>();

  function hitTube(t: Tube, x: number, y: number, vx: number): void {
    // The sound and the tap-nudge are debounced; the carry below is not, so a
    // strike landing inside the debounce window (a press followed instantly
    // by the swipe's first move) still steers the tube the way the swipe went,
    // while a pointer jittering inside a tube can't pump it with nudges.
    const nowMs = performance.now();
    const struck = nowMs - (lastStruck.get(t) ?? 0) >= 100;
    if (struck) {
      lastStruck.set(t, nowMs);
      strike(t.note, t.pan, 0.45 + Math.min(0.55, Math.abs(vx) / 3000));
    }

    // The striker carries the tube with it: contact SETS the tube's angular
    // velocity to follow the pointer at the contact height, rather than
    // adding an impulse. The tube always leaves in the direction of the
    // swipe, a drag can't pump it to absurd speed, and a slower
    // same-direction touch never brakes a tube already flying. A near-still
    // tap just nudges the tube away from the side it was touched on.
    const arm = clamp(y - t.pivotY, 60, t.length);
    const target = clamp((vx / arm) * 0.6, -2.8, 2.8);
    if (Math.abs(target) >= 0.5) {
      if ((target > 0 && target > t.vel) || (target < 0 && target < t.vel)) {
        t.vel = target;
      }
    } else if (struck) {
      const side = x <= t.pivotX + Math.sin(t.angle) * arm ? 1 : -1;
      t.vel = clamp(t.vel + side * (0.7 + Math.random() * 0.4), -2.8, 2.8);
    }
    wake();
  }

  function tubeAtPoint(x: number, y: number): Tube | null {
    for (const t of tubes) {
      if (y < t.pivotY || y > t.pivotY + t.length) continue;
      const cx = t.pivotX + Math.sin(t.angle) * (y - t.pivotY);
      if (Math.abs(x - cx) <= t.halfWidth) return t;
    }
    return null;
  }

  // A fast strum moves many pixels between pointermove events, so testing only
  // the event's own position skips whole tubes. Sweep the segment from the
  // previous position instead: any tube whose horizontal strip the segment
  // touches gets struck — overlap with the whole strip, not just a centreline
  // crossing, or a swipe that starts inside a tube's off-centre half and
  // leaves outward would never register on that tube.
  function sweep(x0: number, y0: number, x1: number, y1: number, vx: number): void {
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    for (const t of tubes) {
      const cx = t.pivotX + Math.sin(t.angle) * t.length * 0.75;
      if (hi < cx - t.halfWidth || lo > cx + t.halfWidth) continue;
      const s = x1 === x0 ? 0.5 : clamp((cx - x0) / (x1 - x0), 0, 1);
      const hitY = y0 + (y1 - y0) * s;
      if (hitY >= t.pivotY && hitY <= t.pivotY + t.length) {
        hitTube(t, x0, hitY, vx);
      }
    }
  }

  // Tracked per pointerId, not one shared record: a stray second contact (a
  // resting palm, a two-finger player) must not corrupt a different finger's
  // still-active strum, and pointercancel (a notification swipe, an incoming
  // call) must end only its own drag.
  const pointers = new Map<number, { x: number; y: number; t: number }>();

  grove.addEventListener("pointerdown", (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, t: performance.now() });
    const t = tubeAtPoint(event.clientX, event.clientY);
    if (t) hitTube(t, event.clientX, event.clientY, 0);
  });
  const endPointer = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
  };
  grove.addEventListener("pointerup", endPointer);
  grove.addEventListener("pointerleave", endPointer);
  grove.addEventListener("pointercancel", endPointer);
  grove.addEventListener("pointermove", (event) => {
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    const nowMs = performance.now();
    const vx = (event.clientX - prev.x) / (Math.max(4, nowMs - prev.t) / 1000);
    sweep(prev.x, prev.y, event.clientX, event.clientY, vx);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, t: nowMs });
  });

  // Keyboard activation (Enter/Space) dispatches "click" with detail 0; pointer
  // clicks carry detail >= 1 and were already handled at pointerdown, so
  // filtering on detail avoids the tap double-strike.
  for (const t of tubes) {
    t.el.addEventListener("click", (event) => {
      if (event.detail !== 0) return;
      hitTube(t, t.pivotX, t.pivotY + t.length * 0.7, 0);
    });
  }

  window.addEventListener("resize", measure);
  window.addEventListener("scroll", measure, { passive: true });
  measure();
}

setupChimes();
