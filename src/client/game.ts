import { Endpoint, type GetDailyStateRsp } from '../shared/api.ts';
import { getStageOpponent } from '../shared/daily.ts';

async function initGame(): Promise<void> {
  const statusEl = document.getElementById('gauntlet-status');
  const stageEl = document.getElementById('stage-info');
  const stage1 = getStageOpponent(1);

  if (stageEl) {
    stageEl.textContent = `Stage ${stage1.stage}: ${stage1.boss.name} (${stage1.boss.creature})`;
  }

  try {
    const rsp = await fetch(`/${Endpoint.GetDailyState}`);
    if (!rsp.ok) {
      if (statusEl) statusEl.textContent = 'Failed to load daily state.';
      return;
    }
    const data = (await rsp.json()) as GetDailyStateRsp;
    if (statusEl) {
      const minutes = Math.floor(data.initialClockMs / 60_000);
      const incSec = Math.floor(data.incrementMs / 1000);
      statusEl.textContent = `${data.dayKey} · Opening ${data.openingRoll.join('')} · ${minutes}+${incSec}`;
    }
  } catch (err) {
    console.warn('Unable to load daily game state', err);
    if (statusEl) statusEl.textContent = 'Offline or unavailable.';
  }
}

void initGame();
