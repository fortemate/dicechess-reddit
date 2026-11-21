const GUEST_ID_KEY = 'dicechess_daily_guest_id';
const GUEST_NICK_KEY = 'dicechess_daily_guest_nick';
const GUIDE_DISMISSED_KEY = 'dicechess_daily_guide_dismissed';

export function getOrCreateGuestId(): string {
  try {
    const existing = window.localStorage.getItem(GUEST_ID_KEY);
    if (existing && /^[a-zA-Z0-9_-]{4,64}$/.test(existing)) {
      return existing;
    }
    const fresh =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    window.localStorage.setItem(GUEST_ID_KEY, fresh);
    return fresh;
  } catch {
    return 'guest_local';
  }
}

export function getGuestNickname(): string {
  try {
    return window.localStorage.getItem(GUEST_NICK_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setGuestNickname(nick: string): void {
  try {
    const trimmed = nick.trim().slice(0, 24);
    if (trimmed) {
      window.localStorage.setItem(GUEST_NICK_KEY, trimmed);
    } else {
      window.localStorage.removeItem(GUEST_NICK_KEY);
    }
  } catch {
    // Ignore storage restriction errors.
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
