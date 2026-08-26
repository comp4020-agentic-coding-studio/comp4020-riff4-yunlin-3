// Bamboo chimes: seven tubes tuned to a five-tone (pentatonic) scale, each one
// a small physical model rather than a sample — so no two strikes, and no two
// players, sound quite the same.

const NOTE_FREQS = [220.0, 246.94, 293.66, 329.63, 392.0, 440.0, 523.25];

let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let dryGain: GainNode | null = null;
let wetGain: GainNode | null = null;
let reverb: ConvolverNode | null = null;

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

function strike(noteIndex: number, pan: number): void {
  const ctx = ensureAudio();
  const freq = NOTE_FREQS[noteIndex];
  const now = ctx.currentTime;

  // Bamboo rings woodier and shorter than metal: a dry knock from the striker,
  // a breathy air-column resonance sitting on the tube's pitch, and a few
  // near-harmonic partials that die quickly. Every strike is still detuned and
  // timed slightly differently, so the same tube never rings twice identically.
  const detune = (Math.random() - 0.5) * 10;
  const decay = 0.9 + Math.random() * 0.5;

  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
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
    env.gain.linearRampToValueAtTime(gain, now + 0.003);
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
  knockEnv.gain.setValueAtTime(0.5, now);
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
  breathEnv.gain.setValueAtTime(0.3, now);
  breathEnv.gain.exponentialRampToValueAtTime(0.0004, now + 0.28);
  breath.connect(breathFilter);
  breathFilter.connect(breathEnv);
  breathEnv.connect(panner);
  breath.start(now);
}

function setupChimes(): void {
  const grove = document.querySelector<HTMLElement>("#grove");
  if (!grove) return;
  const chimes = Array.from(grove.querySelectorAll<HTMLButtonElement>(".chime"));
  const struckRecently = new Set<HTMLButtonElement>();
  // Keyed per chime, not a shared counter: each re-strike's cleanup timeout
  // checks this before clearing "struck", so a fast roll on one tube (well
  // outside the 90ms debounce, well inside the 1.6s animation) doesn't let an
  // earlier strike's stale timer cut the later strike's swing short.
  const strikeToken = new Map<HTMLButtonElement, number>();

  function playChime(chime: HTMLButtonElement): void {
    const noteIndex = Number(chime.dataset.note ?? "0");
    const rect = chime.getBoundingClientRect();
    const groveRect = grove!.getBoundingClientRect();
    const center = rect.left + rect.width / 2 - groveRect.left;
    const pan = (center / groveRect.width) * 2 - 1;

    strike(noteIndex, pan);

    if (struckRecently.has(chime)) {
      chime.classList.remove("struck");
      // Force a reflow so the animation restarts on rapid re-strikes.
      void chime.offsetWidth;
    }
    chime.style.setProperty("--swing-angle", `${(Math.random() - 0.5) * 12 + (pan > 0 ? 5 : -5)}deg`);
    chime.classList.add("struck");
    struckRecently.add(chime);
    const token = (strikeToken.get(chime) ?? 0) + 1;
    strikeToken.set(chime, token);
    setTimeout(() => {
      if (strikeToken.get(chime) !== token) return;
      chime.classList.remove("struck");
      struckRecently.delete(chime);
    }, 1600);
  }

  const activePointers = new Set<number>();
  const lastStruck = new Map<HTMLButtonElement, number>();

  function maybeStrike(target: EventTarget | null): void {
    if (!(target instanceof HTMLButtonElement) || !target.classList.contains("chime")) return;
    const last = lastStruck.get(target) ?? 0;
    const nowMs = performance.now();
    if (nowMs - last < 90) return;
    lastStruck.set(target, nowMs);
    playChime(target);
  }

  // Touch pointers get implicit capture on pointerdown: the browser pins
  // event.target to whichever tube the finger first touched, so a dragging
  // finger's later pointermoves keep reporting that same original tube even
  // as it slides over its neighbours. elementFromPoint reads the real
  // element under the pointer's current coordinates regardless of capture,
  // which is what drag-strum needs; mouse pointers aren't captured, so this
  // is a no-op improvement for them.
  function chimeAt(event: PointerEvent): Element | null {
    return document.elementFromPoint(event.clientX, event.clientY);
  }

  // Tracked per pointerId, not one shared boolean: a stray second contact
  // (a resting palm, a two-finger player) firing its own pointerup must not
  // end a different finger's still-active drag-strum.
  grove.addEventListener("pointerdown", (event) => {
    activePointers.add(event.pointerId);
    maybeStrike(chimeAt(event));
  });
  grove.addEventListener("pointerup", (event) => {
    activePointers.delete(event.pointerId);
  });
  grove.addEventListener("pointerleave", (event) => {
    activePointers.delete(event.pointerId);
  });
  // A touch can be interrupted by the system (a notification swipe, an
  // incoming call, palm rejection) without ever firing "pointerup" --- without
  // this, the next bare pointermove over an untouched tube reads as a drag
  // still in progress and phantom-strikes it.
  grove.addEventListener("pointercancel", (event) => {
    activePointers.delete(event.pointerId);
  });
  grove.addEventListener("pointermove", (event) => {
    if (activePointers.has(event.pointerId)) maybeStrike(chimeAt(event));
  });

  // Keyboard activation (Enter/Space) dispatches "click" with no preceding
  // "pointerdown", so this still needs its own listener --- but it must go
  // through the same debounced path as pointerdown, or a mouse/touch tap
  // (which fires both pointerdown and click) double-strikes the chime.
  for (const chime of chimes) {
    chime.addEventListener("click", () => maybeStrike(chime));
  }
}

setupChimes();
