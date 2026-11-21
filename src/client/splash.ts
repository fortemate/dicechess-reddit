import { requestExpandedMode } from '@devvit/web/client';
import { Endpoint, type GetDailyStateRsp } from '../shared/api.ts';
import { DIE_METADATA, getStageOpponent } from '../shared/daily.ts';
import { bossAvatarSvg, diePipSvg } from './avatars.ts';
import { getOrCreateGuestId } from './guest.ts';

async function initSplash(): Promise<void> {
  const startBtn = document.getElementById(
    'start-btn',
  ) as HTMLButtonElement | null;
  if (startBtn) {
    startBtn.addEventListener('click', (ev) => {
      void requestExpandedMode(ev, 'game');
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

function renderSplash(data: GetDailyStateRsp): void {
  const titleEl = document.getElementById('daily-title');
  const subtitleEl = document.getElementById('daily-subtitle');
  const diceRow = document.getElementById('dice-row');
  const avatarEl = document.getElementById('boss-avatar');
  const huntLabelEl = document.getElementById('hunt-label');
  const huntFillEl = document.getElementById('hunt-fill');
  const leadersList = document.getElementById('leaders-list');
  const startBtn = document.getElementById('start-btn');
  const statusEl = document.getElementById('player-status');

  if (titleEl) {
    titleEl.textContent = `${data.themeName}`;
  }
  if (subtitleEl) {
    subtitleEl.textContent = `Day ${data.dayKey} · Wins Streak · Capture the King`;
  }

  if (diceRow) {
    diceRow.replaceChildren();
    for (const face of data.openingRoll) {
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

  if (leadersList) {
    leadersList.replaceChildren();
    if (data.topLeaders.length === 0) {
      const li = document.createElement('li');
      li.className = 'leader-item';
      li.textContent = 'No completed runs today yet — claim Rank #1!';
      leadersList.appendChild(li);
    } else {
      data.topLeaders.forEach((entry, index) => {
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
  }

  if (startBtn) {
    if (data.activeRun && data.activeRun.status !== 'finished') {
      const opp = getStageOpponent(data.activeRun.currentStage);
      startBtn.textContent =
        data.activeRun.status === 'in_game'
          ? `▶️ Resume Stage ${data.activeRun.currentStage}: ${opp.boss.name}`
          : `⚔️ Continue at Stage ${data.activeRun.currentStage}: ${opp.boss.name}`;
    } else if (data.attemptsToday === 0) {
      startBtn.textContent = '⚔️ Start Daily Gauntlet (⭐ First Try)';
    } else {
      startBtn.textContent = '⚔️ Start New Gauntlet Attempt';
    }
  }

  if (statusEl) {
    const modeLabel = data.isGuest
      ? 'Guest Mode'
      : `Playing as ${data.playerUsername}`;
    statusEl.textContent = `${modeLabel} · Pause between matches · 00:00 UTC reset`;
  }
}

void initSplash();
