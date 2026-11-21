import type { BossId, DiePiece } from '../shared/daily.ts';

const AVATAR_SVGS: Readonly<Record<BossId, string>> = {
  rolly: `<svg viewBox="0 0 80 80" aria-hidden="true">
    <circle cx="40" cy="40" r="38" fill="#fef08a" stroke="#ca8a04" stroke-width="3"/>
    <path d="M16 32 L6 20 L22 24 Z M64 32 L74 20 L58 24 Z" fill="#fde047" stroke="#ca8a04" stroke-width="2"/>
    <circle cx="40" cy="43" r="21" fill="#fde68a" stroke="#a16207" stroke-width="2"/>
    <path d="M18 35 C22 14, 58 14, 62 35 C52 24, 28 24, 18 35 Z" fill="#16a34a"/>
    <circle cx="32" cy="42" r="3.5" fill="#1e293b"/>
    <circle cx="48" cy="42" r="3.5" fill="#1e293b"/>
    <path d="M31 51 Q40 59 49 51" fill="none" stroke="#1e293b" stroke-width="3" stroke-linecap="round"/>
    <rect x="49" y="49" width="16" height="16" rx="3" fill="#ffffff" stroke="#15803d" stroke-width="2"/>
    <circle cx="57" cy="57" r="2.2" fill="#15803d"/>
  </svg>`,
  grabby: `<svg viewBox="0 0 80 80" aria-hidden="true">
    <circle cx="40" cy="40" r="38" fill="#e9d5ff" stroke="#7e22ce" stroke-width="3"/>
    <path d="M15 38 L4 26 L20 28 Z M65 38 L76 26 L60 28 Z" fill="#4ade80" stroke="#15803d" stroke-width="2"/>
    <circle cx="40" cy="44" r="20" fill="#4ade80" stroke="#15803d" stroke-width="2"/>
    <polygon points="24,25 32,12 40,22 48,12 56,25" fill="#facc15" stroke="#a16207" stroke-width="2"/>
    <circle cx="32" cy="42" r="3.5" fill="#1e293b"/>
    <circle cx="48" cy="42" r="3.5" fill="#1e293b"/>
    <path d="M30 52 Q40 58 50 52" fill="none" stroke="#1e293b" stroke-width="3" stroke-linecap="round"/>
    <path d="M24 62 Q40 54 56 62 L56 72 Q40 76 24 72 Z" fill="#7e22ce"/>
  </svg>`,
  rampage: `<svg viewBox="0 0 80 80" aria-hidden="true">
    <circle cx="40" cy="40" r="38" fill="#fecaca" stroke="#b91c1c" stroke-width="3"/>
    <path d="M25 22 L17 7 L32 17 Z M55 22 L63 7 L48 17 Z" fill="#f8fafc" stroke="#475569" stroke-width="2"/>
    <circle cx="40" cy="44" r="20" fill="#ef4444" stroke="#7f1d1d" stroke-width="2"/>
    <path d="M22 33 L58 33 L54 22 L26 22 Z" fill="#475569"/>
    <path d="M28 38 L36 42 M52 38 L44 42" stroke="#1e293b" stroke-width="3" stroke-linecap="round"/>
    <circle cx="32" cy="44" r="3" fill="#fef08a"/>
    <circle cx="48" cy="44" r="3" fill="#fef08a"/>
    <path d="M31 54 Q40 49 49 54" fill="none" stroke="#1e293b" stroke-width="3" stroke-linecap="round"/>
  </svg>`,
  prowla: `<svg viewBox="0 0 80 80" aria-hidden="true">
    <circle cx="40" cy="40" r="38" fill="#fce7f3" stroke="#be185d" stroke-width="3"/>
    <path d="M21 30 L18 11 L34 22 Z M59 30 L62 11 L46 22 Z" fill="#1e293b" stroke="#be185d" stroke-width="2"/>
    <circle cx="40" cy="44" r="20" fill="#1e293b"/>
    <ellipse cx="32" cy="42" rx="4" ry="3" fill="#facc15"/>
    <ellipse cx="48" cy="42" rx="4" ry="3" fill="#facc15"/>
    <circle cx="32" cy="42" r="1.4" fill="#0f172a"/>
    <circle cx="48" cy="42" r="1.4" fill="#0f172a"/>
    <polygon points="37,48 43,48 40,51" fill="#f472b6"/>
    <path d="M34 54 Q40 58 46 54" fill="none" stroke="#f8fafc" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  thinkle: `<svg viewBox="0 0 80 80" aria-hidden="true">
    <circle cx="40" cy="40" r="38" fill="#bae6fd" stroke="#0369a1" stroke-width="3"/>
    <polygon points="40,6 21,31 59,31" fill="#1e3a8a" stroke="#0284c7" stroke-width="2"/>
    <ellipse cx="40" cy="31" rx="26" ry="5" fill="#1d4ed8"/>
    <circle cx="40" cy="45" r="16" fill="#fde68a"/>
    <path d="M24 49 Q40 76 56 49 Z" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.5"/>
    <circle cx="34" cy="42" r="4.5" fill="none" stroke="#0f172a" stroke-width="2"/>
    <circle cx="46" cy="42" r="4.5" fill="none" stroke="#0f172a" stroke-width="2"/>
    <line x1="38.5" y1="42" x2="41.5" y2="42" stroke="#0f172a" stroke-width="2"/>
    <circle cx="34" cy="42" r="1.6" fill="#0f172a"/>
    <circle cx="46" cy="42" r="1.6" fill="#0f172a"/>
  </svg>`,
  ashby: `<svg viewBox="0 0 80 80" aria-hidden="true">
    <circle cx="40" cy="40" r="38" fill="#fed7aa" stroke="#c2410c" stroke-width="3"/>
    <path d="M22 24 L11 8 L29 18 Z M58 24 L69 8 L51 18 Z" fill="#fef3c7" stroke="#b45309" stroke-width="2"/>
    <circle cx="40" cy="44" r="21" fill="#334155" stroke="#0f172a" stroke-width="2"/>
    <path d="M27 56 Q40 68 53 56 L49 48 Q40 53 31 48 Z" fill="#f97316"/>
    <circle cx="32" cy="39" r="3.5" fill="#fbbf24"/>
    <circle cx="48" cy="39" r="3.5" fill="#fbbf24"/>
    <circle cx="36" cy="49" r="1.6" fill="#f8fafc"/>
    <circle cx="44" cy="49" r="1.6" fill="#f8fafc"/>
  </svg>`,
};

export function bossAvatarSvg(bossId: BossId): string {
  return AVATAR_SVGS[bossId];
}

const DIE_PIPS: Readonly<Record<DiePiece, readonly [number, number][]>> = {
  P: [[50, 50]],
  N: [
    [28, 28],
    [72, 72],
  ],
  B: [
    [28, 28],
    [50, 50],
    [72, 72],
  ],
  R: [
    [28, 28],
    [72, 28],
    [28, 72],
    [72, 72],
  ],
  Q: [
    [28, 28],
    [72, 28],
    [50, 50],
    [28, 72],
    [72, 72],
  ],
  K: [
    [28, 24],
    [72, 24],
    [28, 50],
    [72, 50],
    [28, 76],
    [72, 76],
  ],
};

export function diePipSvg(face: DiePiece): string {
  const pips = DIE_PIPS[face]
    .map(
      ([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="9" fill="currentColor"/>`,
    )
    .join('');
  return `<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="6" y="6" width="88" height="88" rx="18" fill="none" stroke="currentColor" stroke-width="6"/>${pips}</svg>`;
}
