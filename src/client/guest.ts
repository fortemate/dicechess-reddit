const GUEST_ID_KEY = 'dicechess_daily_guest_id';
const GUEST_NICK_KEY = 'dicechess_daily_guest_nick';
const GUIDE_DISMISSED_KEY = 'dicechess_daily_guide_dismissed';
const GUEST_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

let memoryGuestId: string | null = null;
let memoryGuestNick: string | null = null;

function generateFreshGuestId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `g_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function getOrCreateGuestId(): string {
  try {
    const existing = window.localStorage.getItem(GUEST_ID_KEY);
    if (existing && GUEST_ID_RE.test(existing)) {
      memoryGuestId = existing;
      return existing;
    }
    const fresh = memoryGuestId ?? generateFreshGuestId();
    memoryGuestId = fresh;
    window.localStorage.setItem(GUEST_ID_KEY, fresh);
    return fresh;
  } catch {
    memoryGuestId ??= generateFreshGuestId();
    return memoryGuestId;
  }
}

export function getGuestNickname(): string {
  if (memoryGuestNick !== null) {
    return memoryGuestNick;
  }
  try {
    const stored = window.localStorage.getItem(GUEST_NICK_KEY);
    memoryGuestNick = stored ?? '';
    return memoryGuestNick;
  } catch {
    return '';
  }
}

/** Saves guest nickname to session memory and `localStorage`, returning storage persistence success. */
export function setGuestNickname(nick: string): boolean {
  const trimmed = nick.trim().slice(0, 24);
  memoryGuestNick = trimmed;
  try {
    if (trimmed) {
      window.localStorage.setItem(GUEST_NICK_KEY, trimmed);
    } else {
      window.localStorage.removeItem(GUEST_NICK_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

export function isMicroGuideDismissed(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissMicroGuide(): void {
  try {
    window.localStorage.setItem(GUIDE_DISMISSED_KEY, '1');
  } catch {
    // Ignore storage restriction errors.
  }
}
