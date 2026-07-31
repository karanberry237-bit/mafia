// hangman.js — Queue-based Hangman with multi-word rotation and cash prize
//
// Flow:
//   host runs /hangman start -> picks words + prize via a private modal
//   bot posts a "Join & Play" button in the channel
//   first person to click becomes the active player and is dealt a random word
//   everyone else who clicks queues up behind them
//   active player guesses via /hangman guess
//     - solve it -> prize awarded, game ends
//     - hit 6 misses (full figure drawn) -> eliminated, next queued player is
//       dealt a NEW word (never the same word as the player right before them)
//   if the queue empties out with no one solving it, the game just waits for
//   more players to join (host or Don can /hangman stop it any time)
//
// Interface:
//   games                                      Map<channelId, gameState>
//   startHangman(channelId, hostId, words, category, prize) -> { success, reason? }
//   joinQueue(channelId, userId)               -> { success, reason?, started?, position? }
//   getGameDisplay(channelId)                  -> string (rendered board)
//   guessLetter(channelId, userId, letter)     -> { success, reason?, hit?, text?, won?, prize?, nextPlayerId? }
//   stopHangman(channelId, userId, isDon)      -> { success, reason?, word? }

const MAX_MISSES = 6; // classic hangman: head, body, 2 arms, 2 legs

const STAGES = [
  "```\n +---+\n     |\n     |\n     |\n    ===\n```",
  "```\n +---+\n |   |\n     |\n     |\n    ===\n```",
  "```\n +---+\n |   |\n O   |\n     |\n    ===\n```",
  "```\n +---+\n |   |\n O   |\n |   |\n    ===\n```",
  "```\n +---+\n |   |\n O   |\n/|   |\n    ===\n```",
  "```\n +---+\n |   |\n O   |\n/|\\  |\n    ===\n```",
  "```\n +---+\n |   |\n O   |\n/|\\  |\n/ \\  |\n    ===\n```",
];

const games = new Map();

function normalizeWord(raw) {
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z ]/g, "");
}

function pickNextWord(game) {
  const pool = game.wordPool;
  if (pool.length === 1) return pool[0];
  let word;
  do {
    word = pool[Math.floor(Math.random() * pool.length)];
  } while (word === game.lastWord && pool.length > 1);
  return word;
}

function startHangman(channelId, hostId, rawWords, category, prize) {
  if (games.has(channelId)) {
    return { success: false, reason: "🪢 A hangman game is already running in this channel." };
  }

  const wordPool = (Array.isArray(rawWords) ? rawWords : [rawWords])
    .map(normalizeWord)
    .filter(w => w && w.replace(/ /g, "").length >= 3);

  if (wordPool.length === 0) {
    return { success: false, reason: "🔫 No valid words — each needs at least 3 letters (A-Z only)." };
  }

  games.set(channelId, {
    hostId,
    category: category || null,
    prize: Math.max(0, parseInt(prize, 10) || 0),
    wordPool,
    lastWord: null,
    queue: [],
    currentPlayerId: null,
    word: null,
    guessed: new Set(),
    misses: 0,
    startedAt: Date.now(),
  });

  return { success: true };
}

function beginTurn(game, userId) {
  game.currentPlayerId = userId;
  game.word = pickNextWord(game);
  game.lastWord = game.word;
  game.guessed = new Set();
  game.misses = 0;
}

function joinQueue(channelId, userId) {
  const game = games.get(channelId);
  if (!game) return { success: false, reason: "🔫 No active hangman game in this channel." };

  if (game.currentPlayerId === userId) {
    return { success: false, reason: "🪢 You're already up — guess with `/hangman guess`." };
  }
  if (game.queue.includes(userId)) {
    return { success: false, reason: `🪢 You're already queued — position **${game.queue.indexOf(userId) + 1}**.` };
  }

  if (game.currentPlayerId === null) {
    beginTurn(game, userId);
    return { success: true, started: true };
  }

  game.queue.push(userId);
  return { success: true, started: false, position: game.queue.length };
}

function renderWord(game) {
  return game.word
    .split("")
    .map(ch => {
      if (ch === " ") return "   ";
      return game.guessed.has(ch) ? ch : "▢";
    })
    .join(" ");
}

function getGameDisplay(channelId) {
  const game = games.get(channelId);
  if (!game) return "🔫 No active hangman game in this channel.";

  if (game.currentPlayerId === null) {
    return "🪢 Waiting for a player to click **Join & Play**.";
  }

  const wrongLetters = [...game.guessed].filter(l => !game.word.includes(l));
  const stage = STAGES[Math.min(game.misses, STAGES.length - 1)];

  const lines = [];
  lines.push(`👤 **Playing now:** <@${game.currentPlayerId}>`);
  if (game.category) lines.push(`📁 **Category:** ${game.category}`);
  if (game.prize > 0) lines.push(`💰 **Prize:** ${game.prize.toLocaleString()}`);
  lines.push(stage);
  lines.push(`**Word:** ${renderWord(game)}`);
  lines.push(`**Misses:** ${game.misses}/${MAX_MISSES}${wrongLetters.length ? `  (wrong: ${wrongLetters.join(", ")})` : ""}`);
  if (game.queue.length) lines.push(`⏳ **Queue:** ${game.queue.map((id, i) => `${i + 1}. <@${id}>`).join(", ")}`);
  lines.push("Guess with `/hangman guess letter:<A-Z>`");

  return lines.join("\n");
}

async function guessLetter(channelId, userId, rawLetter) {
  const game = games.get(channelId);
  if (!game) return { success: false, reason: "🔫 No active hangman game in this channel." };

  if (game.currentPlayerId === null) {
    return { success: false, reason: "🔫 No one's up yet — click **Join & Play** first." };
  }
  if (userId !== game.currentPlayerId) {
    const pos = game.queue.indexOf(userId);
    return {
      success: false,
      reason: pos === -1
        ? "🔫 It's not your turn — click **Join & Play** to queue up."
        : `🔫 It's not your turn yet — you're position **${pos + 1}** in the queue.`,
    };
  }

  const letter = String(rawLetter || "").trim().toUpperCase();
  if (!/^[A-Z]$/.test(letter)) {
    return { success: false, reason: "🔫 Guess must be a single letter A-Z." };
  }
  if (game.guessed.has(letter)) {
    return { success: false, reason: `🔫 **${letter}** has already been guessed.` };
  }

  game.guessed.add(letter);
  const hit = game.word.includes(letter);
  if (!hit) game.misses += 1;

  const won = game.word.split("").every(ch => ch === " " || game.guessed.has(ch));
  const lost = game.misses >= MAX_MISSES;

  let text;
  let result = { success: true, hit };

  if (won) {
    text = `🎉 <@${userId}> solved it! The word was **${game.word}**.` +
      (game.prize > 0 ? `\n💰 <@${userId}> wins **${game.prize.toLocaleString()}**!` : "");
    games.delete(channelId);
    result = { ...result, text, won: true, prize: game.prize };
  } else if (lost) {
    const finishedWord = game.word;
    const eliminated = userId;
    const nextPlayerId = game.queue.shift() || null;

    if (nextPlayerId) {
      beginTurn(game, nextPlayerId);
      text =
        `💀 <@${eliminated}> got hanged! The word was **${finishedWord}**.\n${STAGES[STAGES.length - 1]}\n` +
        `🎯 Next up: <@${nextPlayerId}> — fresh word loaded.`;
      result = { ...result, text, won: false, nextPlayerId };
    } else {
      game.currentPlayerId = null;
      game.word = null;
      text =
        `💀 <@${eliminated}> got hanged! The word was **${finishedWord}**.\n${STAGES[STAGES.length - 1]}\n` +
        `🪢 Queue is empty — click **Join & Play** to keep the game going.`;
      result = { ...result, text, won: false };
    }
  } else {
    text = getGameDisplay(channelId);
    result = { ...result, text };
  }

  return result;
}

function stopHangman(channelId, userId, isDon) {
  const game = games.get(channelId);
  if (!game) return { success: false, reason: "🔫 No active hangman game in this channel." };

  if (userId !== game.hostId && !isDon) {
    return { success: false, reason: "🔫 Only the host who started this game (or Don Clint) can stop it." };
  }

  const word = game.word || "(no word dealt yet)";
  games.delete(channelId);
  return { success: true, word };
}

module.exports = {
  games,
  startHangman,
  joinQueue,
  getGameDisplay,
  guessLetter,
  stopHangman,
};
