import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;

app.use(express.static("public"));

const rooms = new Map();

const RANKS = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K"
];

const SUITS = ["♠", "♥", "♦", "♣"];

const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;

function makeDeck() {
  const deck = [];

  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push({
        id: `${rank}-${suit}-${Math.random().toString(36).slice(2, 8)}`,
        rank,
        suit
      });
    }
  }

  return deck;
}

function shuffle(array) {
  const arr = [...array];

  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr;
}

function createRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code;

  do {
    code = "";

    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));

  return code;
}

function playerIndex(room, socketId) {
  return room.players.findIndex(p => p.id === socketId);
}

function getPlayer(room, socketId) {
  return room.players.find(p => p.id === socketId);
}

function currentPlayer(room) {
  return room.players[room.current];
}

function nextIndex(room, index) {
  if (!room.players.length) return 0;

  return (index + 1) % room.players.length;
}

function cleanName(name) {
  return String(name || "Player")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, 20) || "Player";
}

function cleanMessage(message) {
  return String(message || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, 250);
}

function buildPublicState(room, socketId) {
  const me = getPlayer(room, socketId);

  return {
    code: room.code,

    host: room.host,

    started: room.started,

    phase: room.phase,

    current: room.current,

    currentPlayerId:
      room.players[room.current]?.id || null,

    targetRank: room.targetRank,

    pileCount: room.pile.length,

    declaration: room.declaration
      ? {
          declarer: room.declaration.declarer,
          rank: room.declaration.rank,
          count: room.declaration.count
        }
      : null,

    winner: room.winner,

    message: room.message,

    reveal: room.reveal,

    awaitingDecision: room.awaitingDecision,

    players: room.players.map((p, index) => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      removed: p.removed,
      isHost: p.id === room.host,
      isCurrent: index === room.current
    })),

    hand: me
      ? me.hand
      : [],

    myId: socketId
  };
}

function sendState(room) {
  for (const player of room.players) {
    io.to(player.id).emit(
      "state",
      buildPublicState(room, player.id)
    );
  }
}

function sendError(socket, message) {
  socket.emit("errorMessage", message);
}

function resetReveal(room) {
  room.reveal = null;
}

function startGame(room) {
  if (room.players.length < MIN_PLAYERS) {
    return;
  }

  const deck = shuffle(makeDeck());

  room.started = true;
  room.phase = "play";
  room.winner = null;
  room.pile = [];
  room.declaration = null;
  room.targetRank = null;
  room.reveal = null;
  room.awaitingDecision = false;

  room.players.forEach(player => {
    player.hand = [];
    player.removed = 0;
  });

  /*
    Deal cards clockwise / round-robin.
    This distributes the 52-card deck among all players.
  */

  deck.forEach((card, index) => {
    const player =
      room.players[index % room.players.length];

    player.hand.push(card);
  });

  room.current = Math.floor(
    Math.random() * room.players.length
  );

  const first = currentPlayer(room);

  room.message =
    `${first.name} goes first. Choose one or more cards.`;

  sendState(room);
}

function checkFourOfKind(player) {
  const counts = {};

  for (const card of player.hand) {
    counts[card.rank] =
      (counts[card.rank] || 0) + 1;
  }

  let removedAny = false;

  for (const rank of RANKS) {
    if (counts[rank] === 4) {
      const removed = player.hand.filter(
        card => card.rank === rank
      );

      player.hand = player.hand.filter(
        card => card.rank !== rank
      );

      player.removed += 4;

      removedAny = true;

      console.log(
        `${player.name} removed four ${rank}s from the game.`
      );
    }
  }

  return removedAny;
}

function checkWinner(room) {
  const winner = room.players.find(
    player => player.hand.length === 0
  );

  if (!winner) {
    return false;
  }

  room.winner = winner.id;
  room.phase = "finished";

  room.message =
    `${winner.name} has won Bakakay!`;

  return true;
}

function throwCards(room, socketId, cardIds, rank) {
  if (!room.started) {
    return;
  }

  if (room.phase !== "play") {
    return;
  }

  if (room.awaitingDecision) {
    sendError(
      io.sockets.sockets.get(socketId),
      "Choose TRUTH or LIE before playing a card."
    );
    return;
  }

  const player = getPlayer(room, socketId);

  if (!player) {
    return;
  }

  if (currentPlayer(room)?.id !== socketId) {
    sendError(
  io.sockets.sockets.get(socketId),
  "It is not your turn."
);
    return;
  }

  if (!Array.isArray(cardIds)) {
    sendError(
      io.sockets.sockets.get(socketId),
      "Invalid cards."
    );
    return;
  }

  if (
    cardIds.length < 1 ||
    cardIds.length > player.hand.length
  ) {
    sendError(
      io.sockets.sockets.get(socketId),
      "Choose at least one card."
    );
    return;
  }

  rank = String(rank || "").trim();

  if (room.targetRank && rank !== room.targetRank) {
    sendError(
      io.sockets.sockets.get(socketId),
      `You must declare ${room.targetRank} until someone calls LIE.`
    );
    return;
  }

  if (!RANKS.includes(rank)) {
    sendError(
      io.sockets.sockets.get(socketId),
      "Invalid rank."
    );
    return;
  }

  const uniqueIds = [...new Set(cardIds)];

  if (uniqueIds.length !== cardIds.length) {
    sendError(
      io.sockets.sockets.get(socketId),
      "Invalid card selection."
    );
    return;
  }

  const selected = [];

  for (const id of uniqueIds) {
    const card = player.hand.find(
      c => c.id === id
    );

    if (!card) {
      sendError(
        io.sockets.sockets.get(socketId),
        "One or more selected cards are invalid."
      );
      return;
    }

    selected.push(card);
  }

  /*
    Remove cards from player's hand.
  */

  player.hand = player.hand.filter(
    card => !uniqueIds.includes(card.id)
  );

  /*
    Add cards to central pile.
  */

  room.pile.push(...selected);

  /*
    Save declaration.
  */

  room.declaration = {
    declarer: socketId,
    rank,
    count: selected.length,

    /*
      Whether the cards actually match the declared rank.
    */

    actual:
      selected.every(card => card.rank === rank)
  };

  room.targetRank = rank;

  /*
    The next player decides Truth or Lie.
  */

  room.current =
    nextIndex(
      room,
      playerIndex(room, socketId)
    );

  const challenger = currentPlayer(room);

  room.message =
    `${challenger.name}: decide whether ${player.name}'s claim is TRUE or a LIE.`;

  resetReveal(room);
  room.awaitingDecision = true;

  sendState(room);
}

function resolveChallenge(room, challengerId, saysTruth) {
  if (!room.started || room.phase !== "play" || !room.declaration) {
    return;
  }

  const challenger = getPlayer(room, challengerId);
  if (!challenger || currentPlayer(room)?.id !== challengerId) {
    return;
  }

  if (!room.awaitingDecision) {
    return;
  }

  const declaration = room.declaration;
  const declarer = getPlayer(room, declaration.declarer);
  if (!declarer) {
    return;
  }

  /*
    TRUTH means the challenger accepts the declaration and
    continues the round. Nothing is revealed. The challenger
    immediately gets the turn and MUST keep the same rank.
  */
  if (saysTruth) {
    room.awaitingDecision = false;
    room.reveal = null;
    room.targetRank = declaration.rank;
    room.current = challenger === declarer
      ? room.current
      : playerIndex(room, challenger.id);
    room.message =
      `${challenger.name} accepted the claim as TRUTH. Play ${declaration.rank}s and continue the round.`;

    sendState(room);
    return;
  }

  /*
    LIE is the only action that reveals the most recent
    declaration. The cards are shown before the result is
    applied to the pile/turn state.
  */
  const wasTruth = declaration.actual;

  const revealedCards = room.pile.map(card => ({
    rank: card.rank,
    suit: card.suit
  }));

  room.reveal = {
    result: wasTruth ? "TRUTH" : "LIE",
    cards: revealedCards,
    declarer: declarer.name,
    challenger: challenger.name,
    rank: declaration.rank,
    count: declaration.count
  };

  room.phase = "reveal";

  if (wasTruth) {
    challenger.hand.push(...room.pile);
    room.pile = [];
    room.current = playerIndex(room, declarer.id);
    room.message =
      `${declarer.name} told the TRUTH. ${challenger.name} takes the pile. Turn returns to ${declarer.name}.`;
  } else {
    declarer.hand.push(...room.pile);
    room.pile = [];
    room.current = playerIndex(room, challenger.id);
    room.message =
      `${declarer.name} was LYING. ${declarer.name} takes the pile. ${challenger.name} continues.`;
  }

  room.awaitingDecision = false;

  checkFourOfKind(declarer);
  checkFourOfKind(challenger);
  checkWinner(room);

  sendState(room);
}

function continueAfterReveal(room, socketId) {
  if (!room.reveal) {
    return;
  }

  /*
    Any player can close their own result screen,
    but only the challenger/declarer involved can
    safely continue the game.

    The reveal is only visual state, so clearing it
    doesn't alter the game state.
  */

  room.reveal = null;
  room.awaitingDecision = false;

  if (room.phase === "reveal") {
    if (room.winner) {
      room.phase = "finished";
    } else {
      room.phase = "play";
    }
  }

  sendState(room);
}

io.on("connection", socket => {
  console.log(
    "Connected:",
    socket.id
  );

  socket.on(
    "createRoom",
    ({ name }, callback) => {
      name = cleanName(name);

      const code = createRoomCode();

      const room = {
        code,

        host: socket.id,

        players: [],

        started: false,

        phase: "lobby",

        current: 0,

        targetRank: null,

        pile: [],

        declaration: null,

        winner: null,

        message:
          "Waiting for players...",

        reveal: null,

        awaitingDecision: false,

        chat: []
      };

      rooms.set(code, room);

      room.players.push({
        id: socket.id,

        name,

        hand: [],

        removed: 0
      });

      socket.join(code);

      callback({
        ok: true,
        code
      });

      sendState(room);
    }
  );

  socket.on(
    "joinRoom",
    ({ code, name }, callback) => {
      code = String(code || "")
        .trim()
        .toUpperCase();

      name = cleanName(name);

      const room = rooms.get(code);

      if (!room) {
        callback({
          ok: false,
          error: "Room not found."
        });

        return;
      }

      if (room.started) {
        callback({
          ok: false,
          error:
            "Game has already started."
        });

        return;
      }

      if (
        room.players.length >=
        MAX_PLAYERS
      ) {
        callback({
          ok: false,
          error: "Room is full."
        });

        return;
      }

      if (
        room.players.some(
          player =>
            player.name.toLowerCase() ===
            name.toLowerCase()
        )
      ) {
        callback({
          ok: false,
          error:
            "That name is already in use."
        });

        return;
      }

      room.players.push({
        id: socket.id,

        name,

        hand: [],

        removed: 0
      });

      socket.join(code);

      room.message =
        `${name} joined the room.`;

      callback({
        ok: true,
        code
      });

      sendState(room);
    }
  );

  socket.on(
    "startGame",
    ({ code }) => {
      const room = rooms.get(
        String(code || "")
          .trim()
          .toUpperCase()
      );

      if (!room) {
        return;
      }

      if (room.host !== socket.id) {
        sendError(
          socket,
          "Only the host can start the game."
        );

        return;
      }

      if (
        room.players.length <
        MIN_PLAYERS
      ) {
        sendError(
          socket,
          "At least 2 players are required."
        );

        return;
      }

      startGame(room);
    }
  );

  socket.on(
    "throwCards",
    ({ code, ids, rank }) => {
      const room = rooms.get(
        String(code || "")
          .trim()
          .toUpperCase()
      );

      if (!room) {
        return;
      }

      throwCards(
        room,
        socket.id,
        ids,
        rank
      );
    }
  );

  socket.on(
    "challenge",
    ({ code, truth }) => {
      const room = rooms.get(
        String(code || "")
          .trim()
          .toUpperCase()
      );

      if (!room) {
        return;
      }

      resolveChallenge(
        room,
        socket.id,
        !!truth
      );
    }
  );

  socket.on(
    "continueReveal",
    ({ code }) => {
      const room = rooms.get(
        String(code || "")
          .trim()
          .toUpperCase()
      );

      if (!room) {
        return;
      }

      continueAfterReveal(
        room,
        socket.id
      );
    }
  );

  /*
    REAL-TIME CHAT
  */

  socket.on(
    "chat",
    ({ code, message }) => {
      const room = rooms.get(
        String(code || "")
          .trim()
          .toUpperCase()
      );

      if (!room) {
        return;
      }

      const player = getPlayer(
        room,
        socket.id
      );

      if (!player) {
        return;
      }

      message = cleanMessage(message);

      if (!message) {
        return;
      }

      const chatMessage = {
        id:
          Date.now().toString(36) +
          Math.random()
            .toString(36)
            .slice(2, 7),

        playerId: socket.id,

        name: player.name,

        message,

        time: new Date().toISOString()
      };

      room.chat.push(chatMessage);

      /*
        Keep only the latest 100 messages.
      */

      if (room.chat.length > 100) {
        room.chat.shift();
      }

      io.to(room.code).emit(
        "chatMessage",
        chatMessage
      );
    }
  );

  /*
    Request current chat history.
  */

  socket.on(
    "requestChat",
    ({ code }) => {
      const room = rooms.get(
        String(code || "")
          .trim()
          .toUpperCase()
      );

      if (!room) {
        return;
      }

      if (
        !room.players.some(
          player =>
            player.id === socket.id
        )
      ) {
        return;
      }

      socket.emit(
        "chatHistory",
        room.chat
      );
    }
  );

  /*
    Disconnect handling.
  */

  socket.on(
    "disconnect",
    () => {
      console.log(
        "Disconnected:",
        socket.id
      );

      for (
        const [code, room] of rooms
      ) {
        const index =
          room.players.findIndex(
            player =>
              player.id === socket.id
          );

        if (index < 0) {
          continue;
        }

        const leavingPlayer =
          room.players[index];

        const wasCurrent =
          index === room.current;

        const wasHost =
          room.host === socket.id;

        room.players.splice(
          index,
          1
        );

        /*
          If everyone left, delete room.
        */

        if (
          room.players.length === 0
        ) {
          rooms.delete(code);
          continue;
        }

        /*
          Transfer host.
        */

        if (wasHost) {
          room.host =
            room.players[0].id;
        }

        /*
          If game has started and
          fewer than two players remain,
          return to lobby.
        */

        if (
          room.started &&
          room.players.length < 2
        ) {
          room.started = false;

          room.phase = "lobby";

          room.pile = [];

          room.declaration = null;

          room.targetRank = null;

          room.reveal = null;

          room.winner = null;

          room.players.forEach(
            player => {
              player.hand = [];
              player.removed = 0;
            }
          );
        } else if (
          room.started &&
          wasCurrent
        ) {
          /*
            Keep current index valid.
          */

          if (
            room.current >=
            room.players.length
          ) {
            room.current = 0;
          }
        } else if (
          room.started &&
          index < room.current
        ) {
          room.current--;
        }

        room.message =
          `${leavingPlayer.name} left the room.`;

        sendState(room);
      }
    }
  );
});

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Bakakay server running on 0.0.0.0:${PORT}`
    );
  }
);
