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

const rooms = {};

function genRoomId() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  });
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function publicPlayers(room) {
  return room.players.map(p => ({
    id: p.id, name: p.name, avatar: p.avatar,
    score: p.score, isHost: p.isHost,
    online: p.ws && p.ws.readyState === WebSocket.OPEN,
  }));
}

// Проверяем не завис ли раунд из-за отключившихся игроков
function checkRoundProgress(room) {
  const state = room.state;
  const onlineIds = new Set(room.players.filter(p => p.ws && p.ws.readyState === WebSocket.OPEN).map(p => p.id));

  if (state.phase === 'answering') {
    // Если все онлайн-игроки (кроме сеттера) уже ответили — стартуем голосование
    const setter = room.players[state.setterIdx];
    const pendingOnline = state.answerQueue.filter(id =>
      !state.answeredIds.has(id) && onlineIds.has(id) && id !== setter?.id
    );
    if (pendingOnline.length === 0 && state.answers.length > 0) {
      startVoting(room);
    }
  } else if (state.phase === 'voting') {
    // Если все онлайн-игроки уже проголосовали — финишируем раунд
    const pendingOnline = room.players.filter(id =>
      !state.votedIds.has(id) && onlineIds.has(id)
    );
    if (pendingOnline.length === 0 && Object.keys(state.votes).length > 0) {
      finishRound(room);
    }
  }
}

// ── CREATE ROOM ───────────────────────────────────────────────────
app.post('/api/create-room', async (req, res) => {
  const roomId = genRoomId();
  rooms[roomId] = {
    players: [],
    state: {
      phase: 'lobby',
      round: 0,
      totalRounds: 2,
      setterIdx: 0,
      setterTurnsDone: 0,
      phrase: '',
      answers: [],
      votes: {},
      answeredIds: new Set(),
      votedIds: new Set(),
      answerQueue: [],
    }
  };

  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const joinUrl = `${proto}://${host}/join.html?room=${roomId}`;
  const qr = await QRCode.toDataURL(joinUrl, { width: 256, margin: 2, color: { dark: '#f5c842', light: '#0f0f13' } });

  res.json({ roomId, joinUrl, qr });
});

// ── WEBSOCKET ─────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let myRoomId = null;
  let myPlayerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload } = msg;
    const room = myRoomId ? rooms[myRoomId] : null;

    // ── JOIN или ПЕРЕПОДКЛЮЧЕНИЕ ──
    if (type === 'player:join') {
      const { roomId, name, avatar, isHost } = payload;
      const r = rooms[roomId];
      if (!r) return send(ws, { type: 'error', payload: { message: 'Комната не найдена' } });
      if (!name || !name.trim()) return send(ws, { type: 'error', payload: { message: 'Введи имя' } });

      const trimmedName = name.trim().slice(0, 16);

      // Ищем существующего игрока с таким именем (переподключение)
      const existing = r.players.find(p => p.name.toLowerCase() === trimmedName.toLowerCase());

      if (existing) {
        // Переподключение: восстанавливаем сессию
        existing.ws = ws;
        myPlayerId = existing.id;
        myRoomId = roomId;

        send(ws, {
          type: 'player:reconnected',
          payload: {
            id: existing.id,
            name: existing.name,
            avatar: existing.avatar,
            score: existing.score,
            isHost: existing.isHost,
            // Отправляем текущее состояние игры чтобы клиент восстановился
            gameState: {
              phase: r.state.phase,
              round: r.state.round,
              totalRounds: r.state.totalRounds,
              phrase: r.state.phrase,
              setterId: r.players[r.state.setterIdx]?.id,
              setterName: r.players[r.state.setterIdx]?.name,
              setterAvatar: r.players[r.state.setterIdx]?.avatar,
              answers: r.state.phase === 'voting'
                ? r.state.answers.map((a, i) => ({ idx: i, text: a.text }))
                : [],
              alreadyAnswered: r.state.answeredIds.has(existing.id),
              alreadyVoted: r.state.votedIds.has(existing.id),
              players: publicPlayers(r),
            }
          }
        });

        broadcast(r, { type: 'room:players', payload: { players: publicPlayers(r) } });
        broadcast(r, {
          type: 'player:back',
          payload: { name: existing.name, avatar: existing.avatar }
        });

        // Проверяем не разблокировало ли это застрявший раунд
        checkRoundProgress(r);

      } else {
        // Новый игрок
        if (r.state.phase !== 'lobby') {
          return send(ws, { type: 'error', payload: { message: 'Игра уже идёт. Если ты уже играл — введи своё имя точно как раньше.' } });
        }

        const id = crypto.randomBytes(4).toString('hex');
        myPlayerId = id;
        myRoomId = roomId;
        r.players.push({ id, name: trimmedName, avatar: avatar || '😀', score: 0, ws, isHost: !!isHost });

        send(ws, { type: 'player:joined', payload: { id, name: trimmedName, avatar: avatar || '😀', isHost: !!isHost } });
        broadcast(r, { type: 'room:players', payload: { players: publicPlayers(r) } });
      }
    }

    // ── HOST STARTS GAME ──
    else if (type === 'host:start') {
      if (!room) return;
      const me = room.players.find(p => p.id === myPlayerId);
      if (!me || !me.isHost) return;
      if (room.players.length < 2) return send(ws, { type: 'error', payload: { message: 'Нужно минимум 2 игрока' } });

      room.state.totalRounds = Math.max(1, parseInt(payload.totalRounds) || 2);
      room.state.round = 1;
      room.state.setterIdx = 0;
      room.state.setterTurnsDone = 0;
      room.state.phase = 'phrase';

      const setter = room.players[0];
      broadcast(room, {
        type: 'game:start',
        payload: {
          totalRounds: room.state.totalRounds,
          round: 1,
          setter: { id: setter.id, name: setter.name, avatar: setter.avatar },
          players: publicPlayers(room),
        }
      });
    }

    // ── SETTER SUBMITS PHRASE ──
    else if (type === 'game:phrase') {
      if (!room || room.state.phase !== 'phrase') return;
      const setter = room.players[room.state.setterIdx];
      if (!setter || setter.id !== myPlayerId) return send(ws, { type: 'error', payload: { message: 'Не твоя очередь задавать' } });

      const phrase = (payload.phrase || '').trim();
      if (phrase.length < 3) return send(ws, { type: 'error', payload: { message: 'Фраза слишком короткая' } });

      room.state.phrase = phrase;
      room.state.answers = [];
      room.state.votes = {};
      room.state.answeredIds = new Set();
      room.state.votedIds = new Set();
      room.state.phase = 'answering';

      const answerers = room.players.filter(p => p.id !== setter.id).map(p => p.id);
      room.state.answerQueue = answerers;

      broadcast(room, {
        type: 'game:phrase',
        payload: {
          phrase,
          round: room.state.round,
          totalRounds: room.state.totalRounds,
          setterId: setter.id,
          answererCount: answerers.length,
        }
      });
    }

    // ── PLAYER SUBMITS ANSWER ──
    else if (type === 'game:answer') {
      if (!room || room.state.phase !== 'answering') return;
      if (room.state.answeredIds.has(myPlayerId)) return;
      const setter = room.players[room.state.setterIdx];
      if (setter && setter.id === myPlayerId) return;

      const text = (payload.text || '').trim();
      if (!text) return send(ws, { type: 'error', payload: { message: 'Напиши что-нибудь!' } });

      room.state.answers.push({ text, playerId: myPlayerId });
      room.state.answeredIds.add(myPlayerId);
      send(ws, { type: 'answer:ok' });

      const onlineAnswerers = room.state.answerQueue.filter(id => {
        const p = room.players.find(pl => pl.id === id);
        return p && p.ws && p.ws.readyState === WebSocket.OPEN;
      });
      const remaining = onlineAnswerers.filter(id => !room.state.answeredIds.has(id)).length;

      broadcast(room, {
        type: 'game:answer_progress',
        payload: { remaining, total: onlineAnswerers.length }
      });

      if (remaining === 0) startVoting(room);
    }

    // ── PLAYER VOTES ──
    else if (type === 'game:vote') {
      if (!room || room.state.phase !== 'voting') return;
      if (room.state.votedIds.has(myPlayerId)) return;

      const { answerIdx } = payload;
      if (answerIdx === undefined || answerIdx < 0 || answerIdx >= room.state.answers.length) return;

      const answer = room.state.answers[answerIdx];
      if (answer && answer.playerId === myPlayerId) {
        return send(ws, { type: 'error', payload: { message: 'Нельзя голосовать за свой ответ!' } });
      }

      room.state.votes[myPlayerId] = answerIdx;
      room.state.votedIds.add(myPlayerId);
      send(ws, { type: 'vote:ok' });

      const onlinePlayers = room.players.filter(p => p.ws && p.ws.readyState === WebSocket.OPEN);
      const remaining = onlinePlayers.filter(p => !room.state.votedIds.has(p.id)).length;

      broadcast(room, {
        type: 'game:vote_progress',
        payload: { remaining, total: onlinePlayers.length }
      });

      if (remaining === 0) finishRound(room);
    }

    // ── HOST NEXT ──
    else if (type === 'host:next') {
      if (!room) return;
      const me = room.players.find(p => p.id === myPlayerId);
      if (!me || !me.isHost) return;
      advanceGame(room);
    }
  });

  // ── DISCONNECT ────────────────────────────────────────────────────
  ws.on('close', () => {
    if (!myRoomId) return;
    const room = rooms[myRoomId];
    if (!room) return;

    const player = room.players.find(p => p.id === myPlayerId);
    if (!player) return;

    // Не удаляем игрока — помечаем как оффлайн (ws становится закрытым)
    // Остальные видят кто вышел
    broadcast(room, {
      type: 'player:left',
      payload: { name: player.name, avatar: player.avatar, players: publicPlayers(room) }
    });

    // Если игра идёт — проверяем не разблокируется ли раунд
    if (['answering', 'voting'].includes(room.state.phase)) {
      checkRoundProgress(room);
    }

    // Если комната совсем пустая (все ws закрыты) — удаляем через 30 мин
    const anyOnline = room.players.some(p => p.ws && p.ws.readyState === WebSocket.OPEN);
    if (!anyOnline) {
      setTimeout(() => {
        const r = rooms[myRoomId];
        if (!r) return;
        const stillOnline = r.players.some(p => p.ws && p.ws.readyState === WebSocket.OPEN);
        if (!stillOnline) delete rooms[myRoomId];
      }, 30 * 60 * 1000);
    }
  });
});

// ── GAME HELPERS ──────────────────────────────────────────────────
function startVoting(room) {
  room.state.phase = 'voting';
  room.state.answers = room.state.answers.sort(() => Math.random() - 0.5);
  room.state.votedIds = new Set();

  const anonAnswers = room.state.answers.map((a, i) => ({ idx: i, text: a.text }));
  const setter = room.players[room.state.setterIdx];
  const onlineTotal = room.players.filter(p => p.ws && p.ws.readyState === WebSocket.OPEN).length;

  broadcast(room, {
    type: 'game:voting',
    payload: { answers: anonAnswers, phrase: room.state.phrase, setterId: setter.id, total: onlineTotal }
  });
}

function finishRound(room) {
  room.state.phase = 'results';
  const state = room.state;
  const setter = room.players[state.setterIdx];

  const tally = state.answers.map(() => 0);
  for (const [voterId, ansIdx] of Object.entries(state.votes)) {
    const isSetter = voterId === setter.id;
    tally[ansIdx] += isSetter ? 2 : 1;
  }
  const maxVotes = Math.max(...tally, 0);

  state.answers.forEach((ans, i) => {
    const bonus = (tally[i] === maxVotes && tally[i] > 0) ? 1 : 0;
    const player = room.players.find(p => p.id === ans.playerId);
    if (player) player.score += tally[i] + bonus;
  });

  const results = state.answers.map((ans, i) => {
    const author = room.players.find(p => p.id === ans.playerId);
    return {
      text: ans.text,
      author: author ? author.name : '?',
      avatar: author ? author.avatar : '❓',
      votes: tally[i],
      bonus: (tally[i] === maxVotes && tally[i] > 0),
    };
  }).sort((a, b) => b.votes - a.votes);

  broadcast(room, {
    type: 'game:results',
    payload: { results, players: publicPlayers(room), round: state.round, totalRounds: state.totalRounds }
  });
}

function advanceGame(room) {
  const state = room.state;
  state.setterTurnsDone++;
  const totalTurns = state.totalRounds * room.players.length;
  if (state.setterTurnsDone >= totalTurns) { endGame(room); return; }

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
      setter: { id: setter.id, name: setter.name, avatar: setter.avatar },
      players: publicPlayers(room),
    }
  });
}

function endGame(room) {
  room.state.phase = 'final';
  broadcast(room, { type: 'game:final', payload: { players: publicPlayers(room) } });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Server on port ${PORT}`));
