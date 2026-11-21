import {
  Endpoint,
  type GetDailyStateRsp,
  type GetLeaderboardsRsp,
  type LeaderboardEntry,
  type PauseRunRsp,
  type ResignRunRsp,
  type RunState,
  type ShareCommentRsp,
  type StageEpitaph,
  type StartRunRsp,
  type SubmitTurnRsp,
} from '../shared/api.ts';
import {
  DIE_METADATA,
  GAUNTLET_LADDER,
  getStageOpponent,
  type DiePiece,
} from '../shared/daily.ts';
import { getTurnView, parseFenBoard, type TurnView } from '../shared/engine.ts';
import { playSoundCue } from './audio.ts';
import { bossAvatarSvg, diePipSvg } from './avatars.ts';
import {
  dismissMicroGuide,
  getGuestNickname,
  getOrCreateGuestId,
  isMicroGuideDismissed,
  setGuestNickname,
} from './guest.ts';

type LeaderboardPeriod = 'day' | 'week' | 'month' | 'year';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
const PROMO_PIECES = [
  { code: 'q', label: 'Queen' },
  { code: 'r', label: 'Rook' },
  { code: 'b', label: 'Bishop' },
  { code: 'n', label: 'Knight' },
] as const;

let dailyInfo: GetDailyStateRsp | null = null;
let currentRun: RunState | null = null;
let pendingMoves: string[] = [];
let selectedSquare: string | null = null;
let isSubmitting = false;
let clockBaseLocalMs = Date.now();
let clockElapsedAtSyncMs = 0;
let autoTimeoutTriggered = false;
let lastOutcomeText = '';
let activeLbPeriod: LeaderboardPeriod = 'day';
let cachedLeaderboards: GetLeaderboardsRsp | null = null;

async function init(): Promise<void> {
  setupLightDismissFallback();
  setupControls();
  renderMicroGuide();

  const guestId = getOrCreateGuestId();
  const guestNick = getGuestNickname();

  try {
    const dailyRsp = await fetch(
      `/${Endpoint.GetDailyState}?guestId=${encodeURIComponent(guestId)}`,
    );
    if (dailyRsp.ok) {
      dailyInfo = (await dailyRsp.json()) as GetDailyStateRsp;
    }

    const startRsp = await postJson<StartRunRsp>(Endpoint.StartRun, {
      guestId,
      ...(guestNick ? { guestNickname: guestNick } : {}),
    });
    applyRunUpdate(startRsp.run);
  } catch (err) {
    console.error('Failed to bootstrap game', err);
    const sub = document.getElementById('header-sub');
    if (sub) sub.textContent = 'Connection error — please reload post.';
  }

  window.setInterval(updateClockDisplay, 250);
}

function setupControls(): void {
  const soundBtn = document.getElementById('btn-sound');
  if (soundBtn) {
    import('./audio.ts').then(({ isSoundMuted, setSoundMuted }) => {
      let muted = isSoundMuted();
      soundBtn.textContent = muted ? '🔇' : '🔊';
      soundBtn.addEventListener('click', () => {
        muted = !muted;
        setSoundMuted(muted);
        soundBtn.textContent = muted ? '🔇' : '🔊';
      });
    });
  }

  const rulesDialog = document.getElementById(
    'rules-dialog',
  ) as HTMLDialogElement | null;
  document
    .getElementById('btn-rules')
    ?.addEventListener('click', () => rulesDialog?.showModal());

  const lbDialog = document.getElementById(
    'leaderboard-dialog',
  ) as HTMLDialogElement | null;
  document.getElementById('btn-lb')?.addEventListener('click', () => {
    void openLeaderboards(lbDialog);
  });

  document
    .querySelectorAll<HTMLButtonElement>('[data-period]')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        const period = btn.dataset.period as LeaderboardPeriod | undefined;
        if (!period) return;
        activeLbPeriod = period;
        document
          .querySelectorAll<HTMLButtonElement>('[data-period]')
          .forEach((other) => {
            other.setAttribute(
              'aria-selected',
              other === btn ? 'true' : 'false',
            );
          });
        renderLeaderboardTable();
      });
    });

  document.getElementById('btn-undo')?.addEventListener('click', () => {
    if (isSubmitting || pendingMoves.length === 0) return;
    pendingMoves = pendingMoves.slice(0, -1);
    selectedSquare = null;
    renderAll();
  });

  document.getElementById('btn-commit')?.addEventListener('click', () => {
    void submitPendingTurn();
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && currentRun?.status === 'in_game') {
      const commitBtn = document.getElementById(
        'btn-commit',
      ) as HTMLButtonElement | null;
      if (commitBtn && !commitBtn.disabled) {
        void submitPendingTurn();
      }
    }
  });

  const resignDialog = document.getElementById(
    'resign-dialog',
  ) as HTMLDialogElement | null;
  document
    .getElementById('btn-resign')
    ?.addEventListener('click', () => resignDialog?.showModal());
  document
    .getElementById('btn-confirm-resign')
    ?.addEventListener('click', () => {
      resignDialog?.close();
      void handleResign();
    });

  document.getElementById('btn-next-stage')?.addEventListener('click', () => {
    void handleStartOrAdvance(false);
  });

  document.getElementById('btn-pause')?.addEventListener('click', () => {
    void handlePause();
  });

  document.getElementById('btn-play-again')?.addEventListener('click', () => {
    void handleStartOrAdvance(true);
  });

  document.getElementById('btn-copy-share')?.addEventListener('click', () => {
    void handleCopyShare();
  });

  document.getElementById('btn-post-comment')?.addEventListener('click', () => {
    void handlePostComment();
  });

  document.getElementById('btn-save-nick')?.addEventListener('click', () => {
    const input = document.getElementById(
      'guest-nick-input',
    ) as HTMLInputElement | null;
    if (input) {
      setGuestNickname(input.value);
      const fb = document.getElementById('share-feedback');
      if (fb) fb.textContent = 'Nickname saved for your next run.';
    }
  });
}

function renderMicroGuide(): void {
  const guide = document.getElementById('micro-guide');
  if (!guide || isMicroGuideDismissed()) return;
  guide.classList.remove('hidden');
  document
    .getElementById('btn-dismiss-guide')
    ?.addEventListener('click', () => {
      dismissMicroGuide();
      guide.classList.add('hidden');
    });
}

function setupLightDismissFallback(): void {
  if ('closedBy' in HTMLDialogElement.prototype) return;
  document
    .querySelectorAll<HTMLDialogElement>('dialog[closedby="any"]')
    .forEach((dialog) => {
      let pressedOutside = false;
      const isOutside = (ev: PointerEvent) => {
        const rect = dialog.getBoundingClientRect();
        return (
          ev.clientX < rect.left ||
          ev.clientX > rect.right ||
          ev.clientY < rect.top ||
          ev.clientY > rect.bottom
        );
      };
      dialog.addEventListener('pointerdown', (ev) => {
        pressedOutside = isOutside(ev);
      });
      dialog.addEventListener('pointerup', (ev) => {
        if (pressedOutside && isOutside(ev)) {
          dialog.close();
        }
      });
    });
}

function applyRunUpdate(run: RunState): void {
  currentRun = run;
  pendingMoves = [];
  selectedSquare = null;
  autoTimeoutTriggered = false;
  clockBaseLocalMs = Date.now();
  clockElapsedAtSyncMs = run.activeGame
    ? Math.max(0, run.updatedAtMs - run.activeGame.turnStartedAtMs)
    : 0;
  renderAll();
}

function renderAll(): void {
  if (!currentRun) return;
  const run = currentRun;

  const headerTitle = document.getElementById('header-title');
  const headerSub = document.getElementById('header-sub');
  if (headerTitle) {
    headerTitle.textContent = dailyInfo
      ? `${dailyInfo.themeName} · ${run.dayKey}`
      : `Dice Chess Daily · ${run.dayKey}`;
  }
  if (headerSub) {
    const diceSymbols = run.openingRoll
      .map((d) => DIE_METADATA[d].symbol)
      .join('');
    headerSub.textContent = `Opening ${diceSymbols} · 3+2 · ${run.username}`;
  }

  renderLadderStrip(run);

  const viewGame = document.getElementById('view-game');
  const viewBetween = document.getElementById('view-between');
  const viewFinished = document.getElementById('view-finished');
  viewGame?.classList.toggle('hidden', run.status !== 'in_game');
  viewBetween?.classList.toggle(
    'hidden',
    run.status !== 'paused_between_games',
  );
  viewFinished?.classList.toggle('hidden', run.status !== 'finished');

  if (run.status === 'in_game' && run.activeGame) {
    renderActiveGame(run);
  } else if (run.status === 'paused_between_games') {
    renderBetweenGames(run);
  } else if (run.status === 'finished') {
    renderFinished(run);
  }
}

function renderLadderStrip(run: RunState): void {
  const strip = document.getElementById('ladder-strip');
  if (!strip) return;
  strip.replaceChildren();
  for (const boss of GAUNTLET_LADDER) {
    const item = document.createElement('div');
    item.className = 'ladder-step';
    if (run.currentStage > boss.stage) {
      item.classList.add('cleared');
    } else if (run.currentStage === boss.stage && run.status !== 'finished') {
      item.classList.add('active');
    }
    item.textContent = `${boss.stage}. ${boss.name}`;
    strip.appendChild(item);
  }
}

function renderActiveGame(run: RunState): void {
  const active = run.activeGame;
  if (!active) return;

  const { boss, playerColor, isAscended, ascensionTier } = active.opponent;
  const oppAvatar = document.getElementById('opp-avatar');
  if (oppAvatar) oppAvatar.innerHTML = bossAvatarSvg(boss.id);

  const oppName = document.getElementById('opp-name');
  if (oppName) {
    const tierTag = isAscended ? ` (Ascended +${ascensionTier})` : '';
    oppName.textContent = `Stage ${active.stage}: ${boss.name}${tierTag}`;
  }
  const oppBubble = document.getElementById('opp-bubble');
  if (oppBubble) {
    oppBubble.textContent = active.botLine
      ? `“${active.botLine}”`
      : boss.summary;
  }

  const streakPill = document.getElementById('streak-pill');
  if (streakPill) {
    streakPill.textContent = `${run.wins} ${run.wins === 1 ? 'Win' : 'Wins'} · ${run.totalTurns}t`;
  }
  document
    .getElementById('first-try-pill')
    ?.classList.toggle('hidden', !run.firstTry);

  const turnView = getTurnView(
    active.baseFen,
    active.currentRoll,
    pendingMoves,
    active.plyNumber,
  );

  renderBoard(turnView, playerColor, active.lastBotMoves);
  renderDiceTray(active.currentRoll, turnView);
  renderTurnActions(turnView);
  updateClockDisplay();
}

function renderBoard(
  turnView: TurnView,
  playerColor: 'w' | 'b',
  lastBotMoves: readonly string[],
): void {
  const boardEl = document.getElementById('board');
  if (!boardEl) return;
  boardEl.replaceChildren();

  const parsed = parseFenBoard(turnView.boardFen);
  const legalOrigins = new Set(
    turnView.legalNextMoves.map((move) => move.slice(0, 2)),
  );
  const legalTargets = new Map<string, string[]>();
  if (selectedSquare) {
    for (const move of turnView.legalNextMoves) {
      if (move.startsWith(selectedSquare)) {
        const dest = move.slice(2, 4);
        const list = legalTargets.get(dest) ?? [];
        list.push(move);
        legalTargets.set(dest, list);
      }
    }
  }

  const highlightedLastSquares = new Set<string>();
  const highlightList = pendingMoves.length > 0 ? pendingMoves : lastBotMoves;
  for (const mv of highlightList) {
    highlightedLastSquares.add(mv.slice(0, 2));
    highlightedLastSquares.add(mv.slice(2, 4));
  }

  const ranks =
    playerColor === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const files = playerColor === 'w' ? [...FILES] : [...FILES].reverse();

  for (let rIdx = 0; rIdx < ranks.length; rIdx += 1) {
    const rank = ranks[rIdx]!;
    for (let fIdx = 0; fIdx < files.length; fIdx += 1) {
      const file = files[fIdx]!;
      const sqName = `${file}${rank}`;
      const fileNum = FILES.indexOf(file);
      const isDark = (fileNum + rank) % 2 === 1;
      const piece = parsed.pieces.get(sqName);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = isDark ? 'sq dark' : 'sq';
      btn.dataset.square = sqName;
      btn.setAttribute('role', 'gridcell');

      if (highlightedLastSquares.has(sqName)) btn.classList.add('last-move');
      if (selectedSquare === sqName) btn.classList.add('selected');
      if (!selectedSquare && legalOrigins.has(sqName)) {
        btn.classList.add('legal-origin');
      }

      const matchingMoves = legalTargets.get(sqName);
      if (matchingMoves && matchingMoves.length > 0) {
        btn.classList.add('legal-target');
        if (piece) btn.classList.add('legal-capture');
        if (piece?.toLowerCase() === 'k') btn.classList.add('king-target');
      }

      if (piece) {
        const color = piece === piece.toUpperCase() ? 'w' : 'b';
        const img = document.createElement('img');
        img.src = `/pieces/${color}${piece.toUpperCase()}.svg`;
        img.alt = '';
        img.draggable = false;
        btn.appendChild(img);
      }

      if (fIdx === 0) {
        const rankLabel = document.createElement('span');
        rankLabel.className = 'coord rank';
        rankLabel.setAttribute('aria-hidden', 'true');
        rankLabel.textContent = String(rank);
        btn.appendChild(rankLabel);
      }
      if (rIdx === ranks.length - 1) {
        const fileLabel = document.createElement('span');
        fileLabel.className = 'coord file';
        fileLabel.setAttribute('aria-hidden', 'true');
        fileLabel.textContent = file;
        btn.appendChild(fileLabel);
      }

      const targetDesc =
        matchingMoves && matchingMoves.length > 0
          ? piece?.toLowerCase() === 'k'
            ? 'capture King'
            : 'legal move'
          : '';
      btn.setAttribute(
        'aria-label',
        [sqName, piece ? describePiece(piece) : 'empty', targetDesc]
          .filter(Boolean)
          .join(' '),
      );

      btn.addEventListener('click', () => {
        onSquareTap(sqName, legalOrigins, legalTargets);
      });
      boardEl.appendChild(btn);
    }
  }
}

function onSquareTap(
  square: string,
  legalOrigins: ReadonlySet<string>,
  legalTargets: ReadonlyMap<string, string[]>,
): void {
  if (isSubmitting || !currentRun?.activeGame) return;

  const targetMoves = legalTargets.get(square);
  if (selectedSquare && targetMoves && targetMoves.length > 0) {
    if (targetMoves.length === 1) {
      applyLocalMicroMove(targetMoves[0]!);
      return;
    }
    openPromotionPicker(
      targetMoves,
      currentRun.activeGame.opponent.playerColor,
    );
    return;
  }

  if (legalOrigins.has(square)) {
    selectedSquare = selectedSquare === square ? null : square;
    renderActiveGame(currentRun);
    return;
  }

  if (selectedSquare) {
    selectedSquare = null;
    renderActiveGame(currentRun);
  }
}

function openPromotionPicker(moves: readonly string[], side: 'w' | 'b'): void {
  const dialog = document.getElementById(
    'promo-dialog',
  ) as HTMLDialogElement | null;
  const grid = document.getElementById('promo-grid');
  if (!dialog || !grid) return;

  grid.replaceChildren();
  for (const promo of PROMO_PIECES) {
    const match = moves.find((m) => m.endsWith(promo.code));
    if (!match) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'promo-choice';
    const img = document.createElement('img');
    img.src = `/pieces/${side}${promo.code.toUpperCase()}.svg`;
    img.alt = '';
    const label = document.createElement('span');
    label.textContent = promo.label;
    btn.append(img, label);
    btn.addEventListener('click', () => {
      dialog.close();
      applyLocalMicroMove(match);
    });
    grid.appendChild(btn);
  }
  dialog.showModal();
}

function applyLocalMicroMove(uci: string): void {
  if (!currentRun?.activeGame) return;
  const active = currentRun.activeGame;

  const beforeView = getTurnView(
    active.baseFen,
    active.currentRoll,
    pendingMoves,
    active.plyNumber,
  );
  const parsedBefore = parseFenBoard(beforeView.boardFen);
  const movingPiece = parsedBefore.pieces.get(uci.slice(0, 2));
  const captured = parsedBefore.pieces.get(uci.slice(2, 4));
  const isCastle =
    movingPiece?.toLowerCase() === 'k' &&
    Math.abs(uci.charCodeAt(0) - uci.charCodeAt(2)) === 2;

  pendingMoves = [...pendingMoves, uci];
  selectedSquare = null;

  if (uci.length === 5) playSoundCue('promotion');
  else if (isCastle) playSoundCue('castle');
  else if (captured) playSoundCue('piece_capture');
  else playSoundCue('piece_move');

  const nextView = getTurnView(
    active.baseFen,
    active.currentRoll,
    pendingMoves,
    active.plyNumber,
  );
  renderActiveGame(currentRun);

  if (nextView.terminalResult?.reason === 'king-captured') {
    void submitPendingTurn();
  }
}

function renderDiceTray(
  roll: readonly [DiePiece, DiePiece, DiePiece],
  turnView: TurnView,
): void {
  const tray = document.getElementById('dice-tray');
  if (!tray) return;
  tray.replaceChildren();

  const playablePool = [...turnView.playableDice];
  const remainingPool = [...turnView.remainingDice];

  for (const face of roll) {
    const remIdx = remainingPool.indexOf(face);
    const isSpent = remIdx === -1;
    if (!isSpent) remainingPool.splice(remIdx, 1);

    const playIdx = playablePool.indexOf(face);
    const isPlayable = !isSpent && playIdx !== -1;
    if (isPlayable) playablePool.splice(playIdx, 1);

    const slot = document.createElement('div');
    slot.className = 'die-slot';
    if (isSpent) slot.classList.add('spent');
    else if (isPlayable) slot.classList.add('playable');

    slot.innerHTML = diePipSvg(face);
    const label = document.createElement('span');
    label.textContent = DIE_METADATA[face].label;
    slot.appendChild(label);
    tray.appendChild(slot);
  }
}

function renderTurnActions(turnView: TurnView): void {
  const undoBtn = document.getElementById(
    'btn-undo',
  ) as HTMLButtonElement | null;
  const commitBtn = document.getElementById(
    'btn-commit',
  ) as HTMLButtonElement | null;

  if (undoBtn) {
    undoBtn.disabled = isSubmitting || pendingMoves.length === 0;
  }
  if (commitBtn) {
    commitBtn.disabled = isSubmitting || !turnView.isTurnComplete;
    if (turnView.isForcedPass) {
      commitBtn.textContent = '⏭️ Forced Pass (No Legal Moves)';
    } else if (turnView.terminalResult?.reason === 'king-captured') {
      commitBtn.textContent = '👑 Claim Victory!';
    } else if (turnView.isTurnComplete) {
      commitBtn.textContent = '✅ End Turn';
    } else {
      commitBtn.textContent = `Use Dice (${turnView.playableDice.length} left)`;
    }
  }
}

async function submitPendingTurn(): Promise<void> {
  if (isSubmitting || !currentRun?.activeGame) return;
  const active = currentRun.activeGame;
  const turnView = getTurnView(
    active.baseFen,
    active.currentRoll,
    pendingMoves,
    active.plyNumber,
  );
  if (!turnView.isTurnComplete) return;

  isSubmitting = true;
  renderTurnActions(turnView);

  try {
    const rsp = await postJson<SubmitTurnRsp>(Endpoint.SubmitTurn, {
      guestId: getOrCreateGuestId(),
      runId: currentRun.runId,
      plyNumber: active.plyNumber,
      moves: pendingMoves,
    });

    if (rsp.stageOutcome === 'win') {
      playSoundCue('game_win');
      lastOutcomeText = `Victory vs ${active.opponent.boss.name}!`;
    } else if (rsp.stageOutcome === 'draw') {
      playSoundCue('game_draw');
      lastOutcomeText = `Draw vs ${active.opponent.boss.name} — Streak Held! Replay Stage ${active.stage}`;
    } else if (rsp.stageOutcome === 'loss') {
      playSoundCue('game_loss');
      lastOutcomeText =
        rsp.outcomeReason === 'timeout'
          ? 'Time Expired!'
          : `${active.opponent.boss.name} captured your King!`;
    } else {
      playSoundCue('dice_roll');
    }

    if (dailyInfo) {
      dailyInfo = {
        ...dailyInfo,
        communityHuntCount: rsp.communityHuntCount,
        communityHuntTarget: rsp.communityHuntTarget,
      };
    }

    applyRunUpdate(rsp.run);
  } catch (err) {
    console.error('Turn submit error', err);
    isSubmitting = false;
    renderAll();
  } finally {
    isSubmitting = false;
  }
}

function renderBetweenGames(run: RunState): void {
  const opp = getStageOpponent(run.currentStage);
  const titleEl = document.getElementById('between-title');
  const streakEl = document.getElementById('between-streak');
  const avatarEl = document.getElementById('next-boss-avatar');
  const nameEl = document.getElementById('next-boss-name');
  const summaryEl = document.getElementById('next-boss-summary');
  const epitaphEl = document.getElementById('next-boss-epitaph');
  const nextBtn = document.getElementById('btn-next-stage');
  const pauseNote = document.getElementById('pause-note');

  pauseNote?.classList.add('hidden');
  if (titleEl) {
    titleEl.textContent =
      lastOutcomeText || `Ready for Stage ${run.currentStage}`;
  }
  if (streakEl) {
    const star = run.firstTry ? ' · ⭐ First Try' : '';
    streakEl.textContent = `Current Streak: ${run.wins} ${run.wins === 1 ? 'Win' : 'Wins'} (${run.totalTurns} turns)${star}`;
  }
  if (avatarEl) avatarEl.innerHTML = bossAvatarSvg(opp.boss.id);
  if (nameEl) {
    const sideLabel =
      opp.playerColor === 'w' ? 'You play White' : 'You play Black';
    const ascended = opp.isAscended ? ` · Ascended +${opp.ascensionTier}` : '';
    nameEl.textContent = `Next: Stage ${run.currentStage} — ${opp.boss.name} (${sideLabel}${ascended})`;
  }
  if (summaryEl) summaryEl.textContent = opp.boss.summary;
  if (epitaphEl) {
    epitaphEl.textContent = formatEpitaph(run.nextStageEpitaph, opp.boss.name);
  }
  if (nextBtn) {
    nextBtn.textContent = `⚔️ Fight ${opp.boss.name} (Stage ${run.currentStage})`;
  }
}

function renderFinished(run: RunState): void {
  const titleEl = document.getElementById('finish-title');
  const summaryEl = document.getElementById('finish-summary');
  const huntEl = document.getElementById('finish-hunt');
  const cardEl = document.getElementById('finish-card');
  const nickBox = document.getElementById('guest-nick-box');
  const nickInput = document.getElementById(
    'guest-nick-input',
  ) as HTMLInputElement | null;

  if (titleEl) titleEl.textContent = lastOutcomeText || 'Gauntlet Complete';
  if (summaryEl) {
    const rankStr = run.dailyRank ? ` · Rank #${run.dailyRank} today` : '';
    const star = run.firstTry ? ' · ⭐ First Try' : '';
    summaryEl.textContent = `${run.wins} ${run.wins === 1 ? 'Win' : 'Wins'} (${run.totalTurns} turns)${rankStr}${star}`;
  }
  if (huntEl && dailyInfo) {
    huntEl.textContent = `Community Hunt: ${dailyInfo.communityHuntCount} / ${dailyInfo.communityHuntTarget} defeated ${dailyInfo.dailyBoss.name} today`;
  }
  if (cardEl) {
    cardEl.textContent = run.shareCardText ?? '';
  }
  if (nickBox && nickInput) {
    nickBox.classList.toggle('hidden', !run.isGuest);
    if (run.isGuest && !nickInput.value) {
      nickInput.value = getGuestNickname();
    }
  }
}

function formatEpitaph(
  epitaph: StageEpitaph | undefined,
  bossName: string,
): string {
  if (!epitaph || epitaph.losses === 0) {
    return `No players have fallen to ${bossName} yet today — set the pace!`;
  }
  const base = `${epitaph.eliminationRatePct}% of runs ended at ${bossName} today (${epitaph.losses} defeated)`;
  if (epitaph.lastFallenUser) {
    return `${base} · Last fallen: ${epitaph.lastFallenUser} (${epitaph.lastFallenTurns ?? 0}t)`;
  }
  return base;
}

async function handleStartOrAdvance(forceNew: boolean): Promise<void> {
  if (isSubmitting) return;
  isSubmitting = true;
  try {
    const rsp = await postJson<StartRunRsp>(Endpoint.StartRun, {
      guestId: getOrCreateGuestId(),
      ...(getGuestNickname() ? { guestNickname: getGuestNickname() } : {}),
      forceNew,
    });
    lastOutcomeText = '';
    playSoundCue('dice_roll');
    applyRunUpdate(rsp.run);
  } catch (err) {
    console.error('Failed to start/advance run', err);
  } finally {
    isSubmitting = false;
  }
}

async function handlePause(): Promise<void> {
  if (!currentRun || isSubmitting) return;
  isSubmitting = true;
  try {
    const rsp = await postJson<PauseRunRsp>(Endpoint.PauseRun, {
      guestId: getOrCreateGuestId(),
      runId: currentRun.runId,
    });
    currentRun = rsp.run;
    document.getElementById('pause-note')?.classList.remove('hidden');
  } catch (err) {
    console.error('Pause failed', err);
  } finally {
    isSubmitting = false;
  }
}

async function handleResign(): Promise<void> {
  if (!currentRun || isSubmitting) return;
  isSubmitting = true;
  try {
    const rsp = await postJson<ResignRunRsp>(Endpoint.ResignRun, {
      guestId: getOrCreateGuestId(),
      runId: currentRun.runId,
    });
    lastOutcomeText = 'Run Resigned';
    playSoundCue('game_loss');
    applyRunUpdate(rsp.run);
  } catch (err) {
    console.error('Resign failed', err);
  } finally {
    isSubmitting = false;
  }
}

async function handleCopyShare(): Promise<void> {
  const text = currentRun?.shareCardText ?? '';
  const fb = document.getElementById('share-feedback');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (fb) fb.textContent = 'Copied spoiler-free card to clipboard!';
  } catch {
    if (fb) fb.textContent = 'Copy from the box above to share.';
  }
}

async function handlePostComment(): Promise<void> {
  if (!currentRun || isSubmitting) return;
  const fb = document.getElementById('share-feedback');
  isSubmitting = true;
  try {
    const rsp = await postJson<ShareCommentRsp>(Endpoint.ShareComment, {
      guestId: getOrCreateGuestId(),
      runId: currentRun.runId,
    });
    if (fb) {
      fb.textContent = rsp.posted
        ? 'Posted your run card to the post comments!'
        : (rsp.reason ?? 'Could not post comment directly.');
    }
  } catch {
    if (fb) fb.textContent = 'Comment failed — copy the card above instead.';
  } finally {
    isSubmitting = false;
  }
}

async function openLeaderboards(
  dialog: HTMLDialogElement | null,
): Promise<void> {
  if (!dialog) return;
  dialog.showModal();
  try {
    const rsp = await fetch(`/${Endpoint.GetLeaderboards}`);
    if (rsp.ok) {
      cachedLeaderboards = (await rsp.json()) as GetLeaderboardsRsp;
      renderLeaderboardTable();
    }
  } catch (err) {
    console.warn('Could not load leaderboards', err);
  }
}

function renderLeaderboardTable(): void {
  const tbody = document.getElementById('lb-body');
  if (!tbody) return;
  tbody.replaceChildren();

  const entries: readonly LeaderboardEntry[] = cachedLeaderboards
    ? cachedLeaderboards[activeLbPeriod]
    : [];

  if (entries.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = 'No scores recorded for this period yet.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  entries.forEach((entry, idx) => {
    const tr = document.createElement('tr');
    if (currentRun && entry.playerKey === currentRun.playerKey) {
      tr.className = 'me';
    }
    const c1 = document.createElement('td');
    c1.textContent = `#${idx + 1}`;
    const c2 = document.createElement('td');
    c2.textContent = `${entry.username}${entry.firstTry ? ' ⭐' : ''}`;
    const c3 = document.createElement('td');
    c3.textContent = String(entry.wins);
    const c4 = document.createElement('td');
    c4.textContent = `${entry.totalTurns}t`;
    tr.append(c1, c2, c3, c4);
    tbody.appendChild(tr);
  });
}

function updateClockDisplay(): void {
  if (
    !currentRun ||
    currentRun.status !== 'in_game' ||
    !currentRun.activeGame
  ) {
    return;
  }
  const active = currentRun.activeGame;
  const elapsedMs =
    clockElapsedAtSyncMs + Math.max(0, Date.now() - clockBaseLocalMs);
  const remainingMs = Math.max(0, active.playerRemainingMs - elapsedMs);

  const playerClockEl = document.getElementById('player-clock');
  const oppClockEl = document.getElementById('opp-clock');
  if (playerClockEl) {
    playerClockEl.textContent = formatClock(remainingMs);
    playerClockEl.classList.toggle('low', remainingMs < 15_000);
  }
  if (oppClockEl) {
    oppClockEl.textContent = formatClock(active.botRemainingMs);
  }

  if (remainingMs === 0 && !isSubmitting && !autoTimeoutTriggered) {
    autoTimeoutTriggered = true;
    void postJson<SubmitTurnRsp>(Endpoint.SubmitTurn, {
      guestId: getOrCreateGuestId(),
      runId: currentRun.runId,
      plyNumber: active.plyNumber,
      moves: [],
    })
      .then((rsp) => {
        playSoundCue('game_loss');
        lastOutcomeText = 'Time Expired!';
        applyRunUpdate(rsp.run);
      })
      .catch(() => {});
  }
}

function formatClock(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function describePiece(symbol: string): string {
  const side = symbol === symbol.toUpperCase() ? 'White' : 'Black';
  const pieceKey = symbol.toUpperCase() as DiePiece;
  const label = DIE_METADATA[pieceKey]?.label ?? 'Piece';
  return `${side} ${label}`;
}

async function postJson<T>(endpoint: string, body: unknown): Promise<T> {
  const rsp = await fetch(`/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!rsp.ok) {
    throw new Error(`HTTP ${rsp.status}`);
  }
  return (await rsp.json()) as T;
}

void init();
