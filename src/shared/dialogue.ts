import {
  DIE_METADATA,
  getDailyThemeName,
  type BossId,
  type DailyOpeningRoll,
} from './daily.ts';

export type DialogueEvent =
  | 'intro'
  | 'capture'
  | 'capture_heavy'
  | 'empty_roll'
  | 'threat'
  | 'win'
  | 'loss'
  | 'draw';

export interface DialogueLine {
  readonly id: string;
  readonly bossId: BossId;
  readonly event: DialogueEvent;
  readonly text: string;
}

export interface ShareCardStage {
  readonly stage: number;
  readonly bossName: string;
  readonly outcome: 'win' | 'draw' | 'loss';
  readonly turns: number;
}

export interface ShareCardInput {
  readonly dayKey: string;
  readonly openingRoll: DailyOpeningRoll;
  readonly firstTry: boolean;
  readonly wins: number;
  readonly totalTurns: number;
  readonly rank: number | null;
  readonly stages: readonly ShareCardStage[];
}

const SCRIPTS: Readonly<
  Record<BossId, Readonly<Record<DialogueEvent, readonly string[]>>>
> = {
  rolly: {
    intro: [
      "Hey! Let's roll and see what happens!",
      "Dice ready, board ready! Let's have fun!",
      "I love rolling dice! Hope they're friendly today!",
    ],
    capture: [
      'Boop! Mine now!',
      'Got one! Every little piece counts!',
      'Snack time for my pieces!',
    ],
    capture_heavy: [
      'Whoa! Did I really just grab that big piece?!',
      'Look what I found! Down goes a heavy hitter!',
      'Yay! That was a huge capture!',
    ],
    empty_roll: [
      'Oops, nowhere to go! Your turn!',
      "Nothing to move? That's dice for you!",
      'A blank roll! Well, that was silly!',
    ],
    threat: [
      'Ooh! Your king is right in my path!',
      'Psst... your king might want to hide!',
    ],
    win: [
      'Yay, I won! Can we roll again?!',
      'Woohoo! The dice were super friendly today!',
    ],
    loss: [
      'Aww, good game! You got me fair and square!',
      'My king tripped! Nice catch!',
    ],
    draw: ['A tie?! High five! Let us roll another one!'],
  },
  grabby: {
    intro: [
      'Everything on this board belongs in my collection.',
      "Don't get attached to your pieces. I'm taking them all.",
      'A fresh board! So many shiny pieces to hoard.',
    ],
    capture: [
      "Mine! I'll take that, thank you.",
      'Another piece added to my private collection.',
      "Yoink! You shouldn't leave valuables lying around.",
    ],
    capture_heavy: [
      'Ooh, what a beauty! Straight into my display case!',
      'Exquisite loot! A crown jewel for my hoard!',
      'A masterpiece! I shall polish it every morning.',
    ],
    empty_roll: [
      'No moves?! But I wanted to take something!',
      'A waste of a roll! No loot for my vault this turn.',
    ],
    threat: [
      'Your king would look lovely in my vault.',
      'I spy your king. Very collectible!',
    ],
    win: [
      'Victory and total plunder! What a splendid haul!',
      "Ha! I'll have this whole game framed!",
    ],
    loss: [
      'No! My glorious collection! How dare you?!',
      'Defeated?! My treasures... slipping away...',
    ],
    draw: ['Nobody gets the haul?! Fine, keep your pieces — for now.'],
  },
  rampage: {
    intro: [
      'Step forward. Your king will not survive this day.',
      'No mercy. No retreat. Let the battle begin.',
      'Prepare yourself! I strike without hesitation.',
    ],
    capture: [
      'Obliterated! One less obstacle in my path.',
      'Cut down! Your ranks crumble before me.',
    ],
    capture_heavy: [
      'Crushed! Your mightiest defender falls into dust!',
      'Your high command is broken! Smashed to pieces!',
    ],
    empty_roll: [
      'The dice stall my fury. Savor your brief respite.',
      'No targets?! Unacceptable! Next turn you fall.',
    ],
    threat: [
      'Your king is in my sights!',
      'The right roll, and your king falls!',
    ],
    win: [
      'Total annihilation! Kneel before the conqueror!',
      'Victory was inevitable! You were completely outmatched!',
    ],
    loss: [
      'Impossible! How could my onslaught fail?!',
      'Downed, but not broken! We will battle again!',
    ],
    draw: ['Standoff! Do not think you escaped my storm!'],
  },
  prowla: {
    intro: [
      'Mmm... a new game. Do sit down, darling.',
      "Roll the dice, and let's see what you'll give me.",
    ],
    capture: [
      'Caught you. Purrr...',
      'Pounce! Oh, that was too easy.',
      'Thank you, darling. A lovely little catch.',
    ],
    capture_heavy: [
      'What a prize. Straight under my paw.',
      'Delightful. Patience always pays off.',
    ],
    empty_roll: [
      'Patience... I can wait all night.',
      'Nothing to chase? I shall stretch my paws.',
    ],
    threat: [
      'Careful, little mouse. My claws are near your king.',
      'One lucky roll and the chase is over.',
    ],
    win: [
      'And... pounce. Your king is mine.',
      'A fine chase, darling. Shall we go again?',
    ],
    loss: [
      'Well! You have claws after all.',
      'Beautifully played. You slipped right past me.',
    ],
    draw: ['A cat-and-mouse stalemate. How intriguing.'],
  },
  thinkle: {
    intro: [
      'Hmm... a fresh board, and the stars are out.',
      'Three dice, three little riddles. Shall we begin, my friend?',
    ],
    capture: [
      'Just as the stars suggested.',
      'A tidy little capture. Most satisfying.',
      'Ah, that fits my grand design nicely.',
    ],
    capture_heavy: [
      'Oh, splendid! That one was written in my scrolls.',
      'A decisive shift in the constellations.',
    ],
    empty_roll: [
      'Goodness me! The dice have played a trick on me.',
      'Hmm... even a wizard must wait on fortune.',
    ],
    threat: [
      'Careful now... my spell is drifting toward your king.',
      'As the old saying goes: guard the crown first.',
    ],
    win: [
      'And there it is! A fine game, well played.',
      'The stars aligned neatly today, my friend.',
    ],
    loss: [
      'Well, well... you have outplayed an old wizard. Bravo!',
      'A worthy lesson! My scrolls did not foresee that.',
    ],
    draw: ['Balanced to the very end! Another board awaits.'],
  },
  ashby: {
    intro: [
      'A challenger climbs my mountain. Sit. Roll the dice.',
      'Show me the courage that brought you this high.',
    ],
    capture: ['One more, into the smoke.', 'You left this one in my shadow.'],
    capture_heavy: [
      'A heavy blow. Ember turns to flame.',
      'Your stronghold cracks beneath my wings.',
    ],
    empty_roll: [
      'The dice deny me. Move quickly.',
      'A quiet breath before the mountain stirs.',
    ],
    threat: [
      'Smoke gathers above your king...',
      'Look to your throne. Fire approaches.',
    ],
    win: [
      'Hear the thunder of my wings! This climb ends here.',
      'The mountain stands. Return when you are stronger.',
    ],
    loss: [
      'You have flown higher than I. I bow to you, worthy one.',
      'Remarkable. Even the dragon yields to a sharp blade.',
    ],
    draw: ['Neither peak nor blade gave way. Climb again.'],
  },
};

/** Selects a character dialogue line while avoiding an immediate repeat. */
export function pickCharacterLine(
  bossId: BossId,
  event: DialogueEvent,
  lastLineId?: string,
  random: () => number = Math.random,
): DialogueLine {
  const pool = SCRIPTS[bossId][event];
  const entries: DialogueLine[] = pool.map((text, index) => ({
    id: `${bossId}_${event}_${index + 1}`,
    bossId,
    event,
    text,
  }));
  const filtered =
    entries.length > 1 && lastLineId
      ? entries.filter((item) => item.id !== lastLineId)
      : entries;
  const idx = Math.min(
    filtered.length - 1,
    Math.max(0, Math.floor(random() * filtered.length)),
  );
  return filtered[idx] ?? entries[0]!;
}

/** Formats a spoiler-free share card ready to copy or post as a Reddit comment. */
export function formatSpoilerFreeShareCard(input: ShareCardInput): string {
  const theme = getDailyThemeName(input.openingRoll);
  const diceIcons = input.openingRoll
    .map((die) => DIE_METADATA[die].symbol)
    .join('');
  const firstTryTag = input.firstTry ? ' · ⭐ First Try' : '';
  const chronicle = input.stages
    .map((entry) => {
      const icon =
        entry.outcome === 'win' ? '🟢' : entry.outcome === 'draw' ? '🟡' : '💀';
      return `${icon} ${entry.bossName} (${entry.turns}t)`;
    })
    .join(' → ');
  const rankPart = input.rank !== null ? ` · Rank #${input.rank} today` : '';
  const header = `🎲 Dice Chess Daily — ${input.dayKey} (${theme}: ${diceIcons})${firstTryTag}`;
  const footer = `Streak: ${input.wins} ${input.wins === 1 ? 'Win' : 'Wins'} (${input.totalTurns} turns)${rankPart}`;
  return chronicle
    ? `${header}\n${chronicle}\n${footer}`
    : `${header}\n${footer}`;
}
