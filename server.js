const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── ROOMS ────────────────────────────────────────────────────────
// rooms[roomId] = { host: ws, players: [{id, name, score, ws}], state: {...} }
const rooms = {};

function genRoomId() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // e.g. "A3F9B2"
}

function roomClients(room) {
  return [room.host, ...room.players.map(p => p.ws)].filter(Boolean);
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  roomClients(room).forEach(ws => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

function broadcastExcept(room, excludeWs, msg) {
  const data = JSON.stringify(msg);
  roomClients(room).forEach(ws => {
    if (ws && ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function publicPlayers(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, score: p.score }));
}

// ── QR ENDPOINT ─────────────────────────────────────────────────
app.post('/api/create-room', async (req, res) => {
  const roomId = genRoomId();
  rooms[roomId] = {
    host: null,
    players: [],
    state: {
      phase: 'lobby',      // lobby | phrase | answering | voting | results | final
      round: 0,
      totalRounds: 2,
      setterIdx: 0,
      setterTurnsDone: 0,
      phrase: '',
      answers: [],         // [{text, playerId}]
      votes: {},           // {voterId: answerIdx}
      answerQueue: [],     // player ids still to answer
      voteQueue: [],       // player ids still to vote
    }
  };

  const baseUrl = req.headers['x-forwarded-host']
    ? `https://${req.headers['x-forwarded-host']}`
    : `http://${req.headers.host}`;

  const joinUrl = `${baseUrl}/join.html?room=${roomId}`;
  const qr = await QRCode.toDataURL(joinUrl, { width: 256, margin: 2, color: { dark: '#f5c842', light: '#0f0f13' } });

  res.json({ roomId, joinUrl, qr });
});

app.get('/api/room/:id', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ players: publicPlayers(room), phase: room.state.phase });
});

// ── WEBSOCKET ────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let myRoomId = null;
  let myPlayerId = null;
  let isHost = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload } = msg;

    // ── HOST CONNECTS ──
    if (type === 'host:join') {
      const { roomId } = payload;
      const room = rooms[roomId];
      if (!room) return send(ws, { type: 'error', payload: { message: 'Комната не найдена' } });
      room.host = ws;
      myRoomId = roomId;
      isHost = true;
      send(ws, { type: 'host:joined', payload: { roomId, players: publicPlayers(room) } });
    }

    // ── PLAYER JOINS ──
    else if (type === 'player:join') {
      const { roomId, name } = payload;
      const room = rooms[roomId];
      if (!room) return send(ws, { type: 'error', payload: { message: 'Комната не найдена' } });
      if (room.state.phase !== 'lobby') return send(ws, { type: 'error', payload: { message: 'Игра уже началась' } });
      if (!name || name.trim().length < 1) return send(ws, { type: 'error', payload: { message: 'Введи имя' } });

      const id = crypto.randomBytes(4).toString('hex');
      myPlayerId = id;
      myRoomId = roomId;
      room.players.push({ id, name: name.trim().slice(0, 16), score: 0, ws });

      send(ws, { type: 'player:joined', payload: { id, name: name.trim(), roomId } });
      broadcast(room, { type: 'room:players', payload: { players: publicPlayers(room) } });
    }

    // ── HOST STARTS GAME ──
    else if (type === 'host:start') {
      const room = rooms[myRoomId];
      if (!room || !isHost) return;
      if (room.players.length < 2) return send(ws, { type: 'error', payload: { message: 'Нужно минимум 2 игрока' } });
      const { totalRounds } = payload;
      room.state.totalRounds = Math.max(1, parseInt(totalRounds) || 2);
      room.state.round = 1;
      room.state.setterIdx = 0;
      room.state.setterTurnsDone = 0;
      room.state.phase = 'phrase';

      const setter = room.players[room.state.setterIdx];
      broadcast(room, {
        type: 'game:start',
        payload: {
          totalRounds: room.state.totalRounds,
          round: room.state.round,
          setter: { id: setter.id, name: setter.name },
          players: publicPlayers(room),
        }
      });
    }

    // ── SETTER SUBMITS PHRASE ──
    else if (type === 'game:phrase') {
      const room = rooms[myRoomId];
      if (!room) return;
      const phrase = (payload.phrase || '').trim();
      if (phrase.length < 3) return send(ws, { type: 'error', payload: { message: 'Фраза слишком короткая' } });

      room.state.phrase = phrase;
      room.state.answers = [];
      room.state.votes = {};
      room.state.phase = 'answering';

      // Answer queue = all except setter, shuffled
      const setterPlayer = room.players[room.state.setterIdx];
      const queue = room.players
        .filter(p => p.id !== setterPlayer.id)
        .map(p => p.id)
        .sort(() => Math.random() - 0.5);
      room.state.answerQueue = [...queue];

      broadcast(room, {
        type: 'game:phrase',
        payload: {
          phrase,
          round: room.state.round,
          totalRounds: room.state.totalRounds,
          answerQueue: queue,   // ordered list so host knows who's next
        }
      });

      // Notify first player it's their turn
      notifyNextAnswerer(room);
    }

    // ── PLAYER SUBMITS ANSWER ──
    else if (type === 'game:answer') {
      const room = rooms[myRoomId];
      if (!room || room.state.phase !== 'answering') return;
      const text = (payload.text || '').trim();
      if (!text) return send(ws, { type: 'error', payload: { message: 'Напиши что-нибудь!' } });

      // Record answer
      room.state.answers.push({ text, playerId: myPlayerId });
      room.state.answerQueue = room.state.answerQueue.filter(id => id !== myPlayerId);

      send(ws, { type: 'answer:ok' });

      // Notify host
      send(room.host, {
        type: 'host:answer_received',
        payload: { remaining: room.state.answerQueue.length }
      });

      if (room.state.answerQueue.length === 0) {
        startVoting(room);
      } else {
        notifyNextAnswerer(room);
      }
    }

    // ── PLAYER VOTES ──
    else if (type === 'game:vote') {
      const room = rooms[myRoomId];
      if (!room || room.state.phase !== 'voting') return;
      const { answerIdx } = payload;
      if (answerIdx === undefined) return;

      // Can't vote for own answer
      const answer = room.state.answers[answerIdx];
      if (answer && answer.playerId === myPlayerId) {
        return send(ws, { type: 'error', payload: { message: 'Нельзя голосовать за свой ответ!' } });
      }

      room.state.votes[myPlayerId] = answerIdx;
      room.state.voteQueue = room.state.voteQueue.filter(id => id !== myPlayerId);

      send(ws, { type: 'vote:ok' });
      send(room.host, {
        type: 'host:vote_received',
        payload: { remaining: room.state.voteQueue.length }
      });

      if (room.state.voteQueue.length === 0) {
        finishRound(room);
      }
    }

    // ── HOST ADVANCES (after results shown) ──
    else if (type === 'host:next') {
      const room = rooms[myRoomId];
      if (!room || !isHost) return;
      advanceGame(room);
    }
  });

  ws.on('close', () => {
    if (!myRoomId) return;
    const room = rooms[myRoomId];
    if (!room) return;
    if (isHost) {
      // Host left — notify all
      broadcast(room, { type: 'room:host_left' });
    } else {
      room.players = room.players.filter(p => p.id !== myPlayerId);
      broadcast(room, { type: 'room:players', payload: { players: publicPlayers(room) } });
    }
  });
});

// ── GAME HELPERS ─────────────────────────────────────────────────
function notifyNextAnswerer(room) {
  const nextId = room.state.answerQueue[0];
  const nextPlayer = room.players.find(p => p.id === nextId);
  if (!nextPlayer) return;

  // Tell everyone who's answering now
  broadcast(room, {
    type: 'game:your_turn_answer',
    payload: {
      currentAnswererId: nextId,
      remaining: room.state.answerQueue.length,
    }
  });
}

function startVoting(room) {
  room.state.phase = 'voting';
  // Shuffle answers
  room.state.answers = room.state.answers.sort(() => Math.random() - 0.5);

  const setter = room.players[room.state.setterIdx];
  // Setter votes first, then rest
  const others = room.players.filter(p => p.id !== setter.id).map(p => p.id);
  room.state.voteQueue = [setter.id, ...others.sort(() => Math.random() - 0.5)];

  // Send shuffled answers (without author) to everyone
  const anonAnswers = room.state.answers.map((a, i) => ({ idx: i, text: a.text }));
  broadcast(room, {
    type: 'game:voting',
    payload: {
      answers: anonAnswers,
      phrase: room.state.phrase,
      voteQueue: room.state.voteQueue,
      setterIsFirst: true,
    }
  });

  notifyNextVoter(room);
}

function notifyNextVoter(room) {
  const nextId = room.state.voteQueue[0];
  broadcast(room, {
    type: 'game:your_turn_vote',
    payload: { currentVoterId: nextId }
  });
}

function finishRound(room) {
  room.state.phase = 'results';
  const state = room.state;
  const setter = room.players[state.setterIdx];

  // Tally votes
  const tally = state.answers.map(() => 0);
  for (const [voterId, ansIdx] of Object.entries(state.votes)) {
    const isSetter = voterId === setter.id;
    tally[ansIdx] += isSetter ? 2 : 1;
  }
  const maxVotes = Math.max(...tally, 0);

  // Award points
  state.answers.forEach((ans, i) => {
    const v = tally[i];
    const bonus = (v === maxVotes && v > 0) ? 1 : 0;
    const player = room.players.find(p => p.id === ans.playerId);
    if (player) player.score += v + bonus;
  });

  // Build results
  const results = state.answers.map((ans, i) => {
    const author = room.players.find(p => p.id === ans.playerId);
    return {
      text: ans.text,
      author: author ? author.name : '?',
      votes: tally[i],
      bonus: (tally[i] === maxVotes && tally[i] > 0),
    };
  }).sort((a, b) => b.votes - a.votes);

  broadcast(room, {
    type: 'game:results',
    payload: {
      results,
      players: publicPlayers(room),
      round: state.round,
      totalRounds: state.totalRounds,
    }
  });
}

function advanceGame(room) {
  const state = room.state;
  state.setterTurnsDone++;
  const totalTurns = state.totalRounds * room.players.length;

  if (state.setterTurnsDone >= totalTurns) {
    endGame(room);
    return;
  }

  state.setterIdx = (state.setterIdx + 1) % room.players.length;
  if (state.setterIdx === 0) state.round++;

  if (state.round > state.totalRounds) { endGame(room); return; }

  state.phase = 'phrase';
  const setter = room.players[state.setterIdx];
  broadcast(room, {
    type: 'game:next_turn',
    payload: {
      round: state.round,
      totalRounds: state.totalRounds,
      setter: { id: setter.id, name: setter.name },
      players: publicPlayers(room),
    }
  });
}

function endGame(room) {
  room.state.phase = 'final';
  broadcast(room, {
    type: 'game:final',
    payload: { players: publicPlayers(room) }
  });
}

// ── START ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 Phrase Game server running on port ${PORT}`);
});
