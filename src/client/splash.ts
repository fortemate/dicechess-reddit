import { requestExpandedMode } from '@devvit/web/client';
import { Endpoint, type GetDailyStateRsp } from '../shared/api.ts';

async function initSplash(): Promise<void> {
  const startBtn = document.getElementById('start-btn');
  if (startBtn) {
    startBtn.addEventListener('click', (ev) => {
      void requestExpandedMode(ev, 'game');
    });
  }

  const dayEl = document.getElementById('daily-day');
  const rollEl = document.getElementById('daily-roll');
  const bossEl = document.getElementById('daily-boss');
  const huntEl = document.getElementById('daily-hunt');

  try {
    const rsp = await fetch(`/${Endpoint.GetDailyState}`);
    if (!rsp.ok) return;
    const data = (await rsp.json()) as GetDailyStateRsp;
    if (dayEl) dayEl.textContent = `Day ${data.dayKey}`;
    if (rollEl) {
      rollEl.textContent = `Daily Opening Roll: ${data.openingRoll.join(' ')}`;
    }
    if (bossEl) {
      bossEl.textContent = `Daily Boss: ${data.dailyBoss.name} (${data.dailyBoss.creature})`;
    }
    if (huntEl) {
      huntEl.textContent = `Community Hunt: ${data.communityHuntCount} / ${data.communityHuntTarget}`;
    }
  } catch (err) {
    console.warn('Unable to load daily preview state', err);
  }
}

void initSplash();
