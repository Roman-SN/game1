const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const QRCode  = require('qrcode');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, maxAge: 0,
  setHeaders: res => res.setHeader('Cache-Control', 'no-store'),
}));
app.use(express.json());

const rooms = {};

// ── CONSTANTS ─────────────────────────────────────────────────────
const ROUND_CONFIGS = [
  { label:'Продолжи фразу', emoji:'😄', secs:60,
    hint:'Задающий начинает фразу — продолжи как хочешь, чем смешнее тем лучше',
    setterHint:'Напиши начало любой фразы',
    example:{ phrase:'Мам, я всё объясню, но…', answer:'…это была не я, это был кот' } },
  { label:'Худший совет', emoji:'😈', secs:60,
    hint:'Задающий описывает проблему — дай самый нелепый и бесполезный совет',
    setterHint:'Опиши любую жизненную проблему',
    example:{ phrase:'Я опаздываю на работу…', answer:'Позвони и скажи что умер' } },
  { label:'В рифму', emoji:'🎵', secs:60,
    hint:'Задающий пишет первую строчку — продолжи в рифму (1–2 строки)',
    setterHint:'Напиши первую строчку стихотворения',
    example:{ phrase:'Я встал сегодня в семь утра…', answer:'…и понял: зря' } },
  { label:'Новости', emoji:'📺', secs:60,
    hint:'Задающий пишет абсурдный заголовок — напиши первый абзац этой новости',
    setterHint:'Напиши абсурдный заголовок новости',
    example:{ phrase:'Учёные доказали что…', answer:'Борщ лечит всё кроме скуки. Исследование — 40 бабушек, 3 года.' } },
];

function getRoundInfo(round) {
  // Return a COPY so callers can't mutate the original
  return { ...ROUND_CONFIGS[Math.min(round - 1, ROUND_CONFIGS.length - 1)] };
}

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let id = '';
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ── HELPERS ───────────────────────────────────────────────────────
function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  room.players.forEach(p => {
    if (p.ws?.readyState === WebSocket.OPEN) p.ws.send(data);
  });
}

function send(ws, msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function publicPlayers(room) {
  return room.players.map(p => ({
    id: p.id, name: p.name, avatar: p.avatar,
    score: p.score, isHost: p.isHost,
    online: !!(p.ws?.readyState === WebSocket.OPEN),
  }));
}

// If someone disconnected mid-round, check if we should unblock
function checkRoundProgress(room) {
  const { state } = room;
  const onlineIds = new Set(
    room.players.filter(p => p.ws?.readyState === WebSocket.OPEN).map(p => p.id)
  );
  if (state.phase === 'answering') {
    const setterId = room.players[state.setterIdx]?.id;
    const pending = state.answerQueue.filter(
      id => id !== setterId && onlineIds.has(id) && !state.answeredIds.has(id)
    );
    if (pending.length === 0 && state.answers.length > 0) startVoting(room);
  } else if (state.phase === 'voting') {
    const pending = room.players.filter(
      p => onlineIds.has(p.id) && !state.votedIds.has(p.id)
    );
    if (pending.length === 0 && Object.keys(state.votes).length > 0) finishRound(room);
  }
}

// ── CREATE ROOM ───────────────────────────────────────────────────
app.post('/api/create-room', async (req, res) => {
  let roomId;
  do { roomId = genRoomId(); } while (rooms[roomId]);

  rooms[roomId] = {
    players: [],
    state: {
      phase: 'lobby',
      round: 0,
      totalRounds: 4,
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

  const proto   = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host    = req.headers['x-forwarded-host']  || req.headers.host;
  // Single page — players join via the same index.html with ?room= param
  const joinUrl = `${proto}://${host}/?room=${roomId}`;
  const qr = await QRCode.toDataURL(joinUrl, {
    width: 256, margin: 2, color: { dark: '#f5c842', light: '#0f0f13' }
  });

  res.json({ roomId, joinUrl, qr });
});

// ── WEBSOCKET ─────────────────────────────────────────────────────
wss.on('connection', ws => {
  let myRoomId   = null;
  let myPlayerId = null;

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload } = msg;
    const room = myRoomId ? rooms[myRoomId] : null;

    // JOIN or RECONNECT
    if (type === 'player:join') {
      const { roomId, name, avatar, isHost } = payload;
      const r = rooms[roomId];
      if (!r) return send(ws, { type:'error', payload:{ message:'Комната не найдена. Проверь код.' } });
      if (!name?.trim()) return send(ws, { type:'error', payload:{ message:'Введи имя' } });

      const trimmed  = name.trim().slice(0, 16);
      const existing = r.players.find(p => p.name.toLowerCase() === trimmed.toLowerCase());

      if (existing) {
        // RECONNECT
        existing.ws = ws;
        myPlayerId  = existing.id;
        myRoomId    = roomId;
        const { state } = r;
        const setter = r.players[state.setterIdx];

        send(ws, {
          type: 'player:reconnected',
          payload: {
            id: existing.id, name: existing.name,
            avatar: existing.avatar, score: existing.score,
            isHost: existing.isHost, roomId,
            gameState: {
              phase: state.phase,
              round: state.round, totalRounds: state.totalRounds,
              phrase: state.phrase,
              setterId: setter?.id, setterName: setter?.name, setterAvatar: setter?.avatar,
              roundInfo: getRoundInfo(state.round),
              answers: state.phase === 'voting'
                ? state.answers.map((a, i) => ({ idx: i, text: a.text })) : [],
              alreadyAnswered: state.answeredIds.has(existing.id),
              alreadyVoted:    state.votedIds.has(existing.id),
              players: publicPlayers(r),
            }
          }
        });
        broadcast(r, { type:'room:players', payload:{ players: publicPlayers(r) } });
        broadcast(r, { type:'player:back',  payload:{ name: existing.name, avatar: existing.avatar } });
        checkRoundProgress(r);

      } else {
        // NEW PLAYER
        if (r.state.phase !== 'lobby')
          return send(ws, { type:'error', payload:{ message:'Игра уже идёт. Введи прежнее имя для переподключения.' } });

        const id = crypto.randomBytes(4).toString('hex');
        myPlayerId = id;
        myRoomId   = roomId;
        r.players.push({ id, name: trimmed, avatar: avatar || '😀', score: 0, ws, isHost: !!isHost });

        send(ws, { type:'player:joined', payload:{ id, name: trimmed, avatar: avatar || '😀', isHost: !!isHost, roomId } });
        broadcast(r, { type:'room:players', payload:{ players: publicPlayers(r) } });
      }
      return;
    }

    // HOST START
    if (type === 'host:start') {
      if (!room) return;
      const me = room.players.find(p => p.id === myPlayerId);
      if (!me?.isHost) return;
      if (room.players.length < 2)
        return send(ws, { type:'error', payload:{ message:'Нужно минимум 2 игрока' } });

      room.state.setterIdx       = Math.floor(Math.random() * room.players.length);
      room.state.round           = 1;
      room.state.setterTurnsDone = 0;
      room.state.totalRounds     = 4;
      room.state.phase           = 'phrase';

      const setter    = room.players[room.state.setterIdx];
      const roundInfo = getRoundInfo(1);

      broadcast(room, {
        type: 'game:start',
        payload: {
          round: 1, totalRounds: 4, roundInfo,
          setter: { id: setter.id, name: setter.name, avatar: setter.avatar },
          players: publicPlayers(room),
        }
      });
      return;
    }

    // HOST TUTORIAL DONE → tell everyone to proceed
    if (type === 'host:tutorial_done') {
      if (!room) return;
      const me = room.players.find(p => p.id === myPlayerId);
      if (!me?.isHost) return;
      const setter    = room.players[room.state.setterIdx];
      const roundInfo = getRoundInfo(room.state.round);
      broadcast(room, {
        type: 'game:begin_turn',
        payload: {
          round: room.state.round, totalRounds: room.state.totalRounds, roundInfo,
          setter: { id: setter.id, name: setter.name, avatar: setter.avatar },
          players: publicPlayers(room),
        }
      });
      return;
    }

    // SETTER SUBMITS PHRASE
    if (type === 'game:phrase') {
      if (!room || room.state.phase !== 'phrase') return;
      const setter = room.players[room.state.setterIdx];
      if (!setter || setter.id !== myPlayerId)
        return send(ws, { type:'error', payload:{ message:'Не твоя очередь задавать' } });

      const phrase = (payload.phrase || '').trim();
      if (phrase.length < 3)
        return send(ws, { type:'error', payload:{ message:'Фраза слишком короткая' } });

      room.state.phrase      = phrase;
      room.state.answers     = [];
      room.state.votes       = {};
      room.state.answeredIds = new Set();
      room.state.votedIds    = new Set();
      room.state.phase       = 'answering';

      const answerers = room.players.filter(p => p.id !== setter.id).map(p => p.id);
      room.state.answerQueue = answerers;

      broadcast(room, {
        type: 'game:phrase',
        payload: {
          phrase, setterId: setter.id,
          round: room.state.round, totalRounds: room.state.totalRounds,
          roundInfo: getRoundInfo(room.state.round),
          answererCount: answerers.length,
          secs: getRoundInfo(room.state.round).secs,
        }
      });
      return;
    }

    // PLAYER ANSWERS
    if (type === 'game:answer') {
      if (!room || room.state.phase !== 'answering') return;
      if (room.state.answeredIds.has(myPlayerId)) return;
      const setter = room.players[room.state.setterIdx];
      if (setter?.id === myPlayerId) return; // setter doesn't answer

      const text = (payload.text || '').trim();
      if (!text) return send(ws, { type:'error', payload:{ message:'Напиши что-нибудь!' } });

      room.state.answers.push({ text, playerId: myPlayerId });
      room.state.answeredIds.add(myPlayerId);
      send(ws, { type:'answer:ok' });

      const onlineAnswerers = room.state.answerQueue.filter(id => {
        const p = room.players.find(pl => pl.id === id);
        return p?.ws?.readyState === WebSocket.OPEN;
      });
      const remaining = onlineAnswerers.filter(id => !room.state.answeredIds.has(id)).length;
      broadcast(room, { type:'game:answer_progress', payload:{ remaining, total: onlineAnswerers.length } });
      if (remaining === 0) startVoting(room);
      return;
    }

    // PLAYER VOTES
    if (type === 'game:vote') {
      if (!room || room.state.phase !== 'voting') return;
      if (room.state.votedIds.has(myPlayerId)) return;

      const { answerIdx } = payload;
      if (answerIdx == null || answerIdx < 0 || answerIdx >= room.state.answers.length) return;
      if (room.state.answers[answerIdx]?.playerId === myPlayerId)
        return send(ws, { type:'error', payload:{ message:'Нельзя голосовать за свой ответ!' } });

      room.state.votes[myPlayerId] = answerIdx;
      room.state.votedIds.add(myPlayerId);
      send(ws, { type:'vote:ok' });

      const onlinePlayers = room.players.filter(p => p.ws?.readyState === WebSocket.OPEN);
      const remaining = onlinePlayers.filter(p => !room.state.votedIds.has(p.id)).length;
      broadcast(room, { type:'game:vote_progress', payload:{ remaining, total: onlinePlayers.length } });
      if (remaining === 0) finishRound(room);
      return;
    }

    // HOST NEXT (after results)
    if (type === 'host:next') {
      if (!room) return;
      const me = room.players.find(p => p.id === myPlayerId);
      if (!me?.isHost) return;
      advanceGame(room);
      return;
    }
  });

  ws.on('close', () => {
    if (!myRoomId) return;
    const room = rooms[myRoomId];
    if (!room) return;
    const player = room.players.find(p => p.id === myPlayerId);
    if (!player) return;

    broadcast(room, {
      type: 'player:left',
      payload: { name: player.name, avatar: player.avatar, players: publicPlayers(room) }
    });

    if (['answering', 'voting'].includes(room.state.phase)) checkRoundProgress(room);

    // Clean up empty rooms after 30 min
    const anyOnline = room.players.some(p => p.ws?.readyState === WebSocket.OPEN);
    if (!anyOnline) {
      setTimeout(() => {
        const r = rooms[myRoomId];
        if (r && !r.players.some(p => p.ws?.readyState === WebSocket.OPEN)) delete rooms[myRoomId];
      }, 30 * 60 * 1000);
    }
  });
});

// ── GAME HELPERS ──────────────────────────────────────────────────
function startVoting(room) {
  room.state.phase    = 'voting';
  room.state.answers  = room.state.answers.sort(() => Math.random() - 0.5);
  room.state.votedIds = new Set();

  const setter      = room.players[room.state.setterIdx];
  const onlineTotal = room.players.filter(p => p.ws?.readyState === WebSocket.OPEN).length;

  broadcast(room, {
    type: 'game:voting',
    payload: {
      answers:  room.state.answers.map((a, i) => ({ idx: i, text: a.text })),
      phrase:   room.state.phrase,
      setterId: setter.id,
      total:    onlineTotal,
    }
  });
}

function finishRound(room) {
  room.state.phase = 'results';
  const { state }  = room;
  const setter     = room.players[state.setterIdx];

  const tally = state.answers.map(() => 0);
  for (const [voterId, ansIdx] of Object.entries(state.votes))
    tally[ansIdx] += voterId === setter.id ? 2 : 1;
  const maxVotes = Math.max(...tally, 0);

  state.answers.forEach((ans, i) => {
    const bonus  = (tally[i] === maxVotes && tally[i] > 0) ? 1 : 0;
    const player = room.players.find(p => p.id === ans.playerId);
    if (player) player.score += tally[i] + bonus;
  });

  const results = state.answers
    .map((ans, i) => {
      const author = room.players.find(p => p.id === ans.playerId);
      return { text: ans.text, author: author?.name || '?', avatar: author?.avatar || '❓',
               votes: tally[i], bonus: tally[i] === maxVotes && tally[i] > 0 };
    })
    .sort((a, b) => b.votes - a.votes);

  broadcast(room, {
    type: 'game:results',
    payload: { results, players: publicPlayers(room), round: state.round, totalRounds: state.totalRounds }
  });
}

function advanceGame(room) {
  const { state } = room;
  state.setterTurnsDone++;
  const totalTurns = state.totalRounds * room.players.length;
  if (state.setterTurnsDone >= totalTurns) { endGame(room); return; }

  const prevRound  = state.round;
  state.setterIdx  = (state.setterIdx + 1) % room.players.length;
  if (state.setterIdx === 0) state.round++;
  if (state.round > state.totalRounds) { endGame(room); return; }

  const roundChanged = state.round !== prevRound;
  state.phase = 'phrase';
  const setter    = room.players[state.setterIdx];
  const roundInfo = getRoundInfo(state.round); // fresh copy

  broadcast(room, {
    type: 'game:next_turn',
    payload: {
      round: state.round, totalRounds: state.totalRounds, roundInfo, roundChanged,
      setter: { id: setter.id, name: setter.name, avatar: setter.avatar },
      players: publicPlayers(room),
    }
  });
}

function endGame(room) {
  room.state.phase = 'final';
  broadcast(room, { type:'game:final', payload:{ players: publicPlayers(room) } });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Server on port ${PORT}`));
