import { requestExpandedMode } from '@devvit/web/client';
import {
  Endpoint,
  type GetDailyStateRsp,
  type LeaderboardEntry,
} from '../shared/api.ts';
import {
  DIE_METADATA,
  formatUtcResetCountdown,
  getStageOpponent,
  msUntilNextUtcMidnight,
  type DailyOpeningRoll,
} from '../shared/daily.ts';
import { bossAvatarSvg, diePipSvg } from './avatars.ts';
import { getOrCreateGuestId } from './guest.ts';

async function initSplash(): Promise<void> {
  const startBtn = document.getElementById(
    'start-btn',
  ) as HTMLButtonElement | null;
  if (startBtn) {
    startBtn.addEventListener('click', (ev) => {
      void launchExpandedGame(ev);
    });
  }

  const guestId = getOrCreateGuestId();
  try {
    const rsp = await fetch(
      `/${Endpoint.GetDailyState}?guestId=${encodeURIComponent(guestId)}`,
    );
    if (!rsp.ok) return;
    const data = (await rsp.json()) as GetDailyStateRsp;
    renderSplash(data);
  } catch (err) {
    console.warn('Unable to load daily preview state', err);
  }
}

async function launchExpandedGame(ev: MouseEvent): Promise<void> {
  try {
    await requestExpandedMode(ev, 'game');
  } catch {
    // Allow standalone testing directly at /game.html outside the Reddit host runtime.
    window.location.assign('/game.html');
  }
}

function renderSplash(data: GetDailyStateRsp): void {
  renderSplashHeader(data);
  renderSplashOpeningDice(data.openingRoll);
  renderSplashCommunityHunt(data);
  renderSplashLeaders(data.topLeaders);
  renderSplashActionCta(data);
}

function renderSplashHeader(data: GetDailyStateRsp): void {
  const titleEl = document.getElementById('daily-title');
  const subtitleEl = document.getElementById('daily-subtitle');
  const statusEl = document.getElementById('player-status');

  if (titleEl) {
    titleEl.textContent = data.themeName;
  }
  if (subtitleEl) {
    const rivalHint = data.rivalTarget
      ? ` · Goal: #${data.rivalTarget.rank} ${data.rivalTarget.username} (${data.rivalTarget.wins}W)`
      : '';
    subtitleEl.textContent = `Day ${data.dayKey} · Wins Streak${rivalHint}`;
  }
  if (statusEl) {
    const modeLabel = data.isGuest
      ? 'Guest Mode'
      : `Playing as ${data.playerUsername}`;
    const resetIn = formatUtcResetCountdown(
      msUntilNextUtcMidnight(data.serverNowMs),
    );
    statusEl.textContent = `${modeLabel} · Pause between matches · Resets in ${resetIn}`;
  }
}

function renderSplashOpeningDice(openingRoll: DailyOpeningRoll): void {
  const diceRow = document.getElementById('dice-row');
  if (!diceRow) return;
  diceRow.replaceChildren();
  for (const face of openingRoll) {
    const meta = DIE_METADATA[face];
    const chip = document.createElement('div');
    chip.className = 'die-chip';
    chip.innerHTML = diePipSvg(face);
    const label = document.createElement('span');
    label.textContent = meta.label;
    chip.appendChild(label);
    diceRow.appendChild(chip);
  }
}

function renderSplashCommunityHunt(data: GetDailyStateRsp): void {
  const avatarEl = document.getElementById('boss-avatar');
  const huntLabelEl = document.getElementById('hunt-label');
  const huntFillEl = document.getElementById('hunt-fill');
  const huntBadgeEl = document.getElementById('hunt-badge');

  if (avatarEl) {
    avatarEl.innerHTML = bossAvatarSvg(data.dailyBoss.id);
  }
  if (huntLabelEl) {
    const done = data.communityHuntCount >= data.communityHuntTarget;
    huntLabelEl.textContent = done
      ? `🎉 Goal Reached! ${data.communityHuntCount} defeated ${data.dailyBoss.name}`
      : `${data.communityHuntCount} / ${data.communityHuntTarget} players defeated ${data.dailyBoss.name} today`;
  }
  if (huntFillEl) {
    const pct = Math.min(
      100,
      Math.round(
        (data.communityHuntCount / Math.max(1, data.communityHuntTarget)) * 100,
      ),
    );
    huntFillEl.style.width = `${pct}%`;
  }
  if (huntBadgeEl) {
    huntBadgeEl.classList.toggle('hidden', !data.communityHuntBadge);
    huntBadgeEl.textContent = data.communityHuntBadge ?? '';
  }
}

function renderSplashLeaders(topLeaders: readonly LeaderboardEntry[]): void {
  const leadersList = document.getElementById('leaders-list');
  if (!leadersList) return;
  leadersList.replaceChildren();
  if (topLeaders.length === 0) {
    const li = document.createElement('li');
    li.className = 'leader-item';
    li.textContent = 'No completed runs today yet — claim Rank #1!';
    leadersList.appendChild(li);
    return;
  }

  topLeaders.forEach((entry, index) => {
    const li = document.createElement('li');
    li.className = 'leader-item';
    const left = document.createElement('span');
    const star = entry.firstTry ? ' ⭐' : '';
    left.textContent = `#${index + 1} ${entry.username}${star}`;
    const right = document.createElement('span');
    right.className = 'leader-score';
    right.textContent = `${entry.wins}W · ${entry.totalTurns}t`;
    li.append(left, right);
    leadersList.appendChild(li);
  });
}

function renderSplashActionCta(data: GetDailyStateRsp): void {
  const startBtn = document.getElementById('start-btn');
  if (!startBtn) return;
  if (data.activeRun && data.activeRun.status !== 'finished') {
    const opp = getStageOpponent(data.activeRun.currentStage);
    startBtn.textContent =
      data.activeRun.status === 'in_game'
        ? `▶️ Resume Stage ${data.activeRun.currentStage}: ${opp.boss.name}`
        : `⚔️ Continue at Stage ${data.activeRun.currentStage}: ${opp.boss.name}`;
    return;
  }
  startBtn.textContent =
    data.attemptsToday === 0
      ? '⚔️ Start Daily Gauntlet (⭐ First Try)'
      : '⚔️ Start New Gauntlet Attempt';
}

await initSplash();
