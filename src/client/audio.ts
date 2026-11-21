export type SoundCue =
  | 'dice_roll'
  | 'piece_move'
  | 'piece_capture'
  | 'castle'
  | 'promotion'
  | 'empty_roll'
  | 'game_win'
  | 'game_loss'
  | 'game_draw';

const MUTE_KEY = 'dicechess_daily_muted';
let audioCtx: AudioContext | null = null;
let sessionMuted: boolean | null = null;

export function isSoundMuted(): boolean {
  if (sessionMuted !== null) return sessionMuted;
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSoundMuted(muted: boolean): void {
  sessionMuted = muted;
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // Storage may be disabled in sandboxed WebViews.
  }
}

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  audioCtx ??= new Ctor();
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function tone(
  ctx: AudioContext,
  freq: number,
  endFreq: number,
  durationSec: number,
  delaySec: number,
  type: OscillatorType,
  gainValue: number,
): void {
  const start = ctx.currentTime + delaySec;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (endFreq !== freq) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(40, endFreq),
      start + durationSec,
    );
  }
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(gainValue, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + durationSec);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + durationSec + 0.02);
}

/** Synthesizes crisp, zero-network audio cues via Web Audio API. */
export function playSoundCue(cue: SoundCue): void {
  if (isSoundMuted()) return;
  try {
    const ctx = ensureCtx();
    if (!ctx) return;

    switch (cue) {
      case 'dice_roll':
        tone(ctx, 260, 420, 0.05, 0, 'triangle', 0.06);
        tone(ctx, 340, 520, 0.05, 0.05, 'triangle', 0.06);
        tone(ctx, 480, 620, 0.06, 0.1, 'triangle', 0.05);
        break;
      case 'piece_move':
        tone(ctx, 320, 220, 0.07, 0, 'sine', 0.08);
        break;
      case 'piece_capture':
        tone(ctx, 440, 140, 0.11, 0, 'sawtooth', 0.07);
        break;
      case 'castle':
        tone(ctx, 300, 240, 0.07, 0, 'triangle', 0.08);
        tone(ctx, 390, 310, 0.08, 0.07, 'triangle', 0.08);
        break;
      case 'promotion':
        tone(ctx, 523.25, 659.25, 0.12, 0, 'triangle', 0.08);
        tone(ctx, 659.25, 783.99, 0.16, 0.09, 'triangle', 0.08);
        break;
      case 'empty_roll':
        tone(ctx, 240, 180, 0.18, 0, 'sine', 0.06);
        break;
      case 'game_win':
        tone(ctx, 523.25, 523.25, 0.11, 0, 'triangle', 0.09);
        tone(ctx, 659.25, 659.25, 0.11, 0.1, 'triangle', 0.09);
        tone(ctx, 783.99, 1046.5, 0.25, 0.2, 'triangle', 0.1);
        break;
      case 'game_loss':
        tone(ctx, 392, 349.23, 0.14, 0, 'sawtooth', 0.06);
        tone(ctx, 311.13, 220, 0.28, 0.13, 'sawtooth', 0.06);
        break;
      case 'game_draw':
        tone(ctx, 440, 440, 0.14, 0, 'sine', 0.07);
        tone(ctx, 493.88, 493.88, 0.18, 0.14, 'sine', 0.07);
        break;
    }
  } catch {
    // Audio playback is best-effort and must never interrupt gameplay.
  }
}
