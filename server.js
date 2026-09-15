import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import crypto from 'crypto';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();

const PORT = process.env.PORT || 10000;

app.use(express.static('public'));

const RANKS = [
  'A', '2', '3', '4', '5', '6', '7',
  '8', '9', '10', 'J', 'Q', 'K'
];

const SUITS = ['♠', '♥', '♦', '♣'];

function createRoomCode() {
  let code;

  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (rooms.has(code));

  return code;
}

function createDeck() {
  return SUITS
    .flatMap(suit =>
      RANKS.map(rank => ({
        id: crypto.randomUUID(),
        r: rank,
        s: suit
      }))
    )
    .sort(() => Math.random() - 0.5);
}

function nextPlayer(room, currentIndex) {
  for (let n = 1; n <= room.players.length; n++) {
    const index = (currentIndex + n) % room.players.length;

    if (room.players[index]?.hand.length) {
      return index;
    }
  }

  return -1;
}

function checkFourOfAKind(player) {
  const removedRanks = [];

  for (const rank of RANKS) {
    const matchingCards = player.hand.filter(card => card.r === rank);

    if (matchingCards.length === 4) {
      player.hand = player.hand.filter(card => card.r !== rank);
      player.removed += 4;
      removedRanks.push(rank);
    }
  }

  return removedRanks;
}

function getState(room, socketId) {
  const player = room.players.find(p => p.id === socketId);

  return {
    code: room.code,
    host: room.host,
    started: room.started,
    phase: room.phase,
    current: room.current,
    targetRank: room.targetRank,

    declaration: room.declaration
      ? {
          player: room.declaration.player,
          count: room.declaration.count,
          rank: room.declaration.rank
        }
      : null,

    pileCount: room.pile.length,

    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      removed: p.removed
    })),

    me: player
      ? {
          id: player.id,
          name: player.name,
          hand: player.hand
        }
      : null,

    winner: room.winner,
    message: room.message
  };
}

function sendState(room) {
  room.players.forEach(player => {
    io.to(player.id).emit(
      'state',
      getState(room, player.id)
    );
  });
}

function startGame(room) {
  const deck = createDeck();

  room.players.forEach(player => {
    player.hand = [];
    player.removed = 0;
  });

  // Deal cards clockwise.
  deck.forEach((card, index) => {
    room.players[index % room.players.length].hand.push(card);
  });

  // Remove any four-of-a-kind already present.
  room.players.forEach(player => {
    checkFourOfAKind(player);
  });

  room.current = Math.floor(
    Math.random() * room.players.length
  );

  room.started = true;
  room.phase = 'play';
  room.pile = [];
  room.targetRank = null;
  room.declaration = null;
  room.winner = null;

  room.message =
    `${room.players[room.current].name} is the first player.`;

  sendState(room);
}

function throwCards(room, socketId, ids, rank) {
  const playerIndex = room.players.findIndex(
    player => player.id === socketId
  );

  if (
    playerIndex < 0 ||
    playerIndex !== room.current ||
    room.phase !== 'play'
  ) {
    return;
  }

  const player = room.players[playerIndex];

  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > player.hand.length
  ) {
    return;
  }

  // Once a rank has been established, the same rank must be used.
  if (room.targetRank && rank !== room.targetRank) {
    return;
  }

  const selectedCards = player.hand.filter(
    card => ids.includes(card.id)
  );

  // Make sure every selected ID actually belongs to this player.
  if (selectedCards.length !== ids.length) {
    return;
  }

  player.hand = player.hand.filter(
    card => !ids.includes(card.id)
  );

  room.pile.push(...selectedCards);

  const isTruth = selectedCards.every(
    card => card.r === rank
  );

  room.declaration = {
    player: playerIndex,
    count: selectedCards.length,
    rank: rank,
    actual: isTruth
  };

  room.targetRank = rank;

  // Empty hand = winner.
  if (player.hand.length === 0) {
    room.winner = player.name;
    room.phase = 'gameover';
    room.message =
      `${player.name} emptied their hand and wins!`;

    sendState(room);
    return;
  }

  room.current = nextPlayer(room, playerIndex);
  room.phase = 'challenge';

  room.message =
    `${player.name} declared ${selectedCards.length} × ${rank}. ` +
    `${room.players[room.current].name}, choose TRUTH or LIE.`;

  sendState(room);
}

function challenge(room, socketId, truth) {
  const challengerIndex = room.players.findIndex(
    player => player.id === socketId
  );

  if (
    challengerIndex !== room.current ||
    room.phase !== 'challenge' ||
    !room.declaration
  ) {
    return;
  }

  const declaration = room.declaration;

  // Challenger accepts the declaration.
  if (truth) {
    room.phase = 'play';
    room.current = challengerIndex;

    room.message =
      `${room.players[challengerIndex].name} accepted the claim. ` +
      `Use the same rank: ${declaration.rank}.`;

    sendState(room);
    return;
  }

  // Challenger calls LIE.
  const cards = room.pile.splice(0);

  const declarerIndex = declaration.player;
  const wasTruth = declaration.actual;

  if (wasTruth) {
    // The declaration was true.
    // Challenger takes the entire pile.
    room.players[challengerIndex].hand.push(...cards);
    room.current = declarerIndex;
  } else {
    // The declaration was a lie.
    // Declarer takes the entire pile.
    room.players[declarerIndex].hand.push(...cards);
    room.current = challengerIndex;
  }

  // Check for four-of-a-kind after picking up the pile.
  const completedSets = [];

  room.players.forEach(player => {
    const removed = checkFourOfAKind(player);

    removed.forEach(rank => {
      completedSets.push(
        `${player.name} completed four ${rank}s`
      );
    });
  });

  // Check winner.
  if (!room.players[room.current].hand.length) {
    room.winner = room.players[room.current].name;
    room.phase = 'gameover';
  } else {
    room.phase = 'play';
  }

  if (wasTruth) {
    room.message =
      `TRUTH! ${room.players[declarerIndex].name} was telling the truth. ` +
      `${room.players[challengerIndex].name} takes the pile; ` +
      `turn returns to ${room.players[declarerIndex].name}.`;
  } else {
    room.message =
      `LIE! ${room.players[declarerIndex].name} was lying. ` +
      `${room.players[declarerIndex].name} takes the pile; ` +
      `${room.players[challengerIndex].name} starts.`;
  }

  if (completedSets.length) {
    room.message += ' ' + completedSets.join('. ') + '.';
  }

  room.declaration = null;
  room.targetRank = null;

  sendState(room);
}

io.on('connection', socket => {

  // CREATE ROOM
  socket.on('createRoom', ({ name }, callback) => {
    name = String(name || 'Player')
      .trim()
      .slice(0, 20);

    const roomCode = createRoomCode();

    const room = {
      code: roomCode,
      host: socket.id,
      players: [],
      started: false,
      phase: 'lobby',
      current: 0,
      targetRank: null,
      pile: [],
      declaration: null,
      winner: null,
      message: 'Waiting for players...'
    };

    rooms.set(roomCode, room);

    room.players.push({
      id: socket.id,
      name,
      hand: [],
      removed: 0
    });

    socket.join(roomCode);

    callback({
      ok: true,
      code: roomCode
    });

    sendState(room);
  });

  // JOIN ROOM
  socket.on('joinRoom', ({ code, name }, callback) => {
    code = String(code || '')
      .trim()
      .toUpperCase();

    name = String(name || 'Player')
      .trim()
      .slice(0, 20);

    const room = rooms.get(code);

    if (!room) {
      return callback({
        ok: false,
        error: 'Room not found.'
      });
    }

    if (room.started) {
      return callback({
        ok: false,
        error: 'Game already started.'
      });
    }

    if (room.players.length >= 10) {
      return callback({
        ok: false,
        error: 'Room is full.'
      });
    }

    if (
      room.players.some(
        player =>
          player.name.toLowerCase() === name.toLowerCase()
      )
    ) {
      return callback({
        ok: false,
        error: 'That name is already in use.'
      });
    }

    room.players.push({
      id: socket.id,
      name,
      hand: [],
      removed: 0
    });

    socket.join(code);

    room.message = `${name} joined the room.`;

    callback({
      ok: true,
      code
    });

    sendState(room);
  });

  // START GAME
  socket.on('startGame', ({ code }) => {
    const room = rooms.get(code);

    if (
      room &&
      room.host === socket.id &&
      room.players.length >= 2
    ) {
      startGame(room);
    }
  });

  // THROW CARDS
  socket.on('throwCards', ({ code, ids, rank }) => {
    const room = rooms.get(code);

    if (room) {
      throwCards(
        room,
        socket.id,
        ids,
        rank
      );
    }
  });

  // TRUTH / LIE
  socket.on('challenge', ({ code, truth }) => {
    const room = rooms.get(code);

    if (room) {
      challenge(
        room,
        socket.id,
        Boolean(truth)
      );
    }
  });

  // PLAYER DISCONNECTS
  socket.on('disconnect', () => {

    for (const [roomCode, room] of rooms) {

      const playerIndex = room.players.findIndex(
        player => player.id === socket.id
      );

      if (playerIndex < 0) {
        continue;
      }

      const playerName =
        room.players[playerIndex].name;

      const wasCurrentPlayer =
        playerIndex === room.current;

      room.players.splice(playerIndex, 1);

      // Delete empty room.
      if (room.players.length === 0) {
        rooms.delete(roomCode);
        continue;
      }

      // Give host role to the next player.
      if (room.host === socket.id) {
        room.host = room.players[0].id;
      }

      // If fewer than 2 players remain,
      // return the room to the lobby.
      if (
        room.started &&
        room.players.length < 2
      ) {
        room.started = false;
        room.phase = 'lobby';
        room.pile = [];
        room.declaration = null;
        room.targetRank = null;
        room.winner = null;
      }

      // If the disconnected player was taking the turn,
      // move the turn to the next available position.
      else if (
        room.started &&
        wasCurrentPlayer
      ) {
        room.current =
          playerIndex % room.players.length;
      }

      // If someone before the current player left,
      // adjust the current index.
      else if (
        room.started &&
        playerIndex < room.current
      ) {
        room.current--;
      }

      room.message =
        `${playerName} left the room.`;

      sendState(room);
    }
  });
});

// Start server.
server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Bakakay server running on port ${PORT}`
  );
});
