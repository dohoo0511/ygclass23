// 방 하나의 모든 규칙 (Durable Object 와 테스트가 같이 쓴다)
//
// 방에는 '자리(size)' 가 있다. 방장이 게임을 고르고 그 게임이 허용하는 인원 안에서 자리 수를 정한다.
// 자리보다 늦게 들어온 사람, 스스로 관전을 고른 사람은 관전자가 된다.
import { GAMES, catalog } from "./games/index.js";

export const ROOM_LIMIT = 12; // 관전자를 포함해 한 방에 들어올 수 있는 최대 인원
const GRACE_MS = 20000; // 연결이 끊긴 사람을 기다려 주는 시간 (새로고침 대비)
const CHAT_KEEP = 40;

function rid(random) {
  return Math.floor(random() * 36 ** 8).toString(36).padStart(8, "0");
}

function cleanName(raw) {
  const n = String(raw || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 12);
  return n || "손님";
}

export class RoomCore {
  constructor({ now = () => Date.now(), random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.now = now;
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.conns = new Map(); // conn -> pid
    this.players = []; // {id, name, connected, spectator, wins, conn}
    this.hostId = null;
    this.gameId = "liar";
    this.size = GAMES.liar.max;
    this.phase = "lobby"; // lobby | playing | result
    this.game = null; // {id, state, participants}
    this.gen = 0;
    this.timers = new Set();
    this.chat = [];
    this.code = "";
  }

  get playerCount() {
    return this.players.length;
  }

  // ---------- 연결 ----------
  message(conn, raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    const pid = this.conns.get(conn);
    if (m.t === "hello") return this.hello(conn, m);
    if (!pid) return;
    const p = this.player(pid);
    if (!p) return;
    switch (m.t) {
      case "ping":
        return this.send(conn, { t: "pong" });
      case "chat":
        return this.onChat(p, m.text);
      case "config":
        return this.onConfig(p, m);
      case "seat":
        return this.onSeat(p, !!m.spectator);
      case "start":
        return this.onStart(p);
      case "lobby":
        return this.onLobby(p);
      case "act":
        return this.onAct(p, m.a);
      case "rename":
        p.name = this.uniqueName(cleanName(m.name), p.id);
        return this.broadcast();
    }
  }

  hello(conn, m) {
    if (this.conns.has(conn)) return;
    let p = m.pid && this.player(String(m.pid));
    if (p) {
      if (p.conn && p.conn !== conn) {
        this.conns.delete(p.conn);
        p.conn.close(4000, "다른 창에서 다시 들어왔어요");
      }
    } else {
      if (this.players.length >= ROOM_LIMIT) {
        this.send(conn, { t: "error", msg: "방이 가득 찼어요", fatal: true });
        return conn.close(4001, "full");
      }
      p = {
        id: rid(this.random),
        name: this.uniqueName(cleanName(m.name)),
        connected: true,
        spectator: this.seated().length >= this.size || this.phase !== "lobby",
        autoSpec: false,
        wins: 0,
        joinedAt: this.now(),
      };
      p.autoSpec = p.spectator;
      this.players.push(p);
      this.system(`${p.name}님이 들어왔어요`);
    }
    p.conn = conn;
    p.connected = true;
    this.conns.set(conn, p.id);
    if (!this.hostId || !this.player(this.hostId)) this.hostId = p.id;
    this.send(conn, { t: "welcome", pid: p.id, code: this.code, games: catalog(), chat: this.chat });
    this.broadcast();
  }

  disconnect(conn) {
    const pid = this.conns.get(conn);
    this.conns.delete(conn);
    const p = pid && this.player(pid);
    if (!p || p.conn !== conn) return;
    p.conn = null;
    p.connected = false;
    this.broadcast();
    // 게임 타이머와 따로 둔다 (게임이 바뀌어도 살아 있어야 함)
    this.setTimer(() => this.dropIfGone(p.id), GRACE_MS);
  }

  dropIfGone(pid) {
    const p = this.player(pid);
    if (!p || p.connected) return;
    const inGame = this.phase === "playing" && this.game?.participants.includes(pid);
    if (!inGame) {
      this.players = this.players.filter((x) => x.id !== pid);
      this.system(`${p.name}님이 나갔어요`);
    }
    if (this.hostId === pid) {
      const next = this.players.find((x) => x.connected);
      this.hostId = next ? next.id : this.players[0]?.id || null;
      if (next) this.system(`${next.name}님이 새 방장이에요`);
    }
    this.fillSeats();
    this.broadcast();
  }

  // ---------- 로비 ----------
  seated() {
    return this.players.filter((p) => !p.spectator);
  }

  fillSeats() {
    if (this.phase !== "lobby") return;
    // 자리가 넘치면 늦게 온 사람부터 관전으로
    const seated = this.seated();
    for (let i = seated.length - 1; i >= this.size; i--) {
      seated[i].spectator = true;
      seated[i].autoSpec = true;
    }
    // 자리가 생기면, 자리가 없어서 관전하던 사람을 먼저 온 순서대로 앉힌다
    let free = this.size - this.seated().length;
    for (const p of this.players) {
      if (free <= 0) break;
      if (p.spectator && p.autoSpec) {
        p.spectator = false;
        p.autoSpec = false;
        free--;
      }
    }
  }

  onConfig(p, m) {
    if (p.id !== this.hostId) return this.err(p, "방장만 바꿀 수 있어요");
    if (this.phase === "playing") return this.err(p, "게임 중에는 바꿀 수 없어요");
    if (m.game && GAMES[m.game] && m.game !== this.gameId) {
      this.gameId = m.game;
      const g = GAMES[m.game];
      // 게임을 바꾸면, 지금 자리에 앉은 사람 수에 맞춰 자리 수를 정해 준다
      this.size = Math.max(g.min, Math.min(g.max, Math.max(this.seated().length, this.size)));
    }
    if (m.size != null) {
      const g = GAMES[this.gameId];
      const n = Math.round(Number(m.size));
      if (Number.isFinite(n)) this.size = Math.max(g.min, Math.min(g.max, n));
    }
    if (this.phase === "result") this.toLobby();
    this.fillSeats();
    this.broadcast();
  }

  onSeat(p, spectator) {
    if (this.phase === "playing") return this.err(p, "게임이 끝나면 바꿀 수 있어요");
    if (!spectator && p.spectator && this.seated().length >= this.size) return this.err(p, "자리가 다 찼어요");
    p.spectator = spectator;
    p.autoSpec = false;
    this.broadcast();
  }

  onChat(p, text) {
    const t = String(text || "").trim().slice(0, 200);
    if (!t) return;
    this.pushChat({ pid: p.id, name: p.name, text: t, at: this.now() });
  }

  system(text) {
    this.pushChat({ pid: null, name: "", text, at: this.now(), sys: true });
  }

  pushChat(c) {
    this.chat.push(c);
    if (this.chat.length > CHAT_KEEP) this.chat.shift();
    this.broadcastRaw({ t: "chat", c });
  }

  // ---------- 게임 ----------
  onStart(p) {
    if (p.id !== this.hostId) return this.err(p, "방장만 시작할 수 있어요");
    if (this.phase === "playing") return;
    const g = GAMES[this.gameId];
    const ps = this.seated().filter((x) => x.connected);
    if (ps.length < g.min) return this.err(p, `${g.name}은(는) ${g.min}명 이상 있어야 해요 (지금 ${ps.length}명)`);
    if (ps.length > Math.min(g.max, this.size)) return this.err(p, `${g.name}은(는) ${g.max}명까지 할 수 있어요`);
    this.stopTimers();
    const ctx = this.ctx();
    const state = g.setup(ps.map((x) => ({ id: x.id, name: x.name })), ctx);
    this.game = { id: g.id, state, participants: ps.map((x) => x.id) };
    this.phase = "playing";
    this.system(`${g.emoji} ${g.name} 시작! (${ps.length}명)`);
    this.afterChange();
  }

  onLobby(p) {
    if (p.id !== this.hostId) return this.err(p, "방장만 할 수 있어요");
    if (this.phase === "playing") this.system("방장이 게임을 멈췄어요");
    this.toLobby();
    this.broadcast();
  }

  toLobby() {
    this.stopTimers();
    this.phase = "lobby";
    this.game = null;
    // 끝난 게임 사이에 끊긴 사람 정리
    this.players = this.players.filter((x) => x.connected || x.conn);
    this.fillSeats();
  }

  onAct(p, a) {
    if (this.phase !== "playing" || !this.game) return;
    if (!this.game.participants.includes(p.id)) return this.err(p, "관전 중이에요");
    const g = GAMES[this.game.id];
    const e = g.action(this.game.state, p.id, a, this.ctx());
    if (e) return this.err(p, e);
    this.afterChange();
  }

  ctx() {
    const gen = this.gen;
    return {
      now: this.now,
      random: this.random,
      schedule: (ms, key) => {
        const h = this.setTimer(() => {
          this.timers.delete(h);
          if (gen !== this.gen || !this.game || this.phase !== "playing") return;
          GAMES[this.game.id].timer(this.game.state, key, this.ctx());
          this.afterChange();
        }, ms);
        this.timers.add(h);
      },
    };
  }

  stopTimers() {
    this.gen++;
    for (const h of this.timers) this.clearTimer(h);
    this.timers.clear();
  }

  afterChange() {
    const s = this.game?.state;
    if (this.phase === "playing" && s?.over) {
      this.phase = "result";
      this.stopTimers();
      for (const id of s.over.winners || []) {
        const w = this.player(id);
        if (w) w.wins++;
      }
      this.system(s.over.text);
    }
    this.broadcast();
  }

  // ---------- 보내기 ----------
  roomView() {
    return {
      code: this.code,
      hostId: this.hostId,
      gameId: this.gameId,
      size: this.size,
      phase: this.phase,
      limit: ROOM_LIMIT,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        spectator: p.spectator,
        wins: p.wins,
        playing: !!this.game?.participants.includes(p.id),
      })),
    };
  }

  gameView(pid) {
    if (!this.game) return null;
    const g = GAMES[this.game.id];
    return {
      id: g.id,
      view: g.view(this.game.state, pid, this.ctx()),
      over: this.game.state.over || null,
      participants: this.game.participants,
    };
  }

  broadcast() {
    const room = this.roomView();
    for (const [conn, pid] of this.conns) this.send(conn, { t: "state", room, game: this.gameView(pid) });
  }

  broadcastRaw(msg) {
    const s = JSON.stringify(msg);
    for (const conn of this.conns.keys()) conn.send(s);
  }

  send(conn, msg) {
    conn.send(JSON.stringify(msg));
  }

  err(p, msg) {
    if (p.conn) this.send(p.conn, { t: "error", msg });
  }

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  uniqueName(name, selfId) {
    let n = name;
    let i = 2;
    while (this.players.some((p) => p.name === n && p.id !== selfId)) n = `${name}${i++}`;
    return n;
  }
}
