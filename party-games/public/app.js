import { h, countdown, tickCountdowns } from "./dom.js";
import { RENDER } from "./games.js";

const $ = (s) => document.querySelector(s);

const S = {
  ws: null,
  code: null,
  pid: null,
  games: [],
  room: null,
  game: null,
  receivedAt: 0,
  chat: [],
  retry: 0,
  leaving: false,
  pingTimer: null,
};

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  // 방마다 내 자리 번호는 탭마다 따로 (같은 기기에서 창 두 개로도 시험해 볼 수 있게)
  getPid(code) {
    try {
      return sessionStorage.getItem(`pg_pid_${code}`);
    } catch {
      return null;
    }
  },
  setPid(code, pid) {
    try {
      sessionStorage.setItem(`pg_pid_${code}`, pid);
    } catch {}
  },
};

// ---------- 알림 ----------
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- 첫 화면 ----------
function myName() {
  return $("#name").value.trim();
}

function needName() {
  if (myName()) {
    store.set("pg_name", myName());
    return false;
  }
  toast("이름을 먼저 적어 주세요");
  $("#name").focus();
  return true;
}

$("#name").value = store.get("pg_name") || "";

$("#create").addEventListener("click", async () => {
  if (needName()) return;
  $("#create").disabled = true;
  try {
    const r = await fetch("/api/new").then((r) => r.json());
    if (!r.code) throw new Error(r.error || "방을 못 만들었어요");
    enterRoom(r.code);
  } catch (e) {
    toast(e.message || "서버에 연결할 수 없어요");
  } finally {
    $("#create").disabled = false;
  }
});

$("#code").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

$("#join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("#code").value.trim().toUpperCase();
  if (code.length !== 4) return toast("방 코드 4자리를 적어 주세요");
  if (needName()) return;
  enterRoom(code);
});

fetch("/api/games")
  .then((r) => r.json())
  .then((list) => {
    S.games = list;
    $("#game-list").replaceChildren(
      ...list.map((g) =>
        h("li", null, h("span", { class: "emoji" }, g.emoji), h("div", null, h("b", null, g.name), " ", h("span", { class: "pill" }, people(g)), h("p", null, g.short)))
      )
    );
  })
  .catch(() => {});

function people(g) {
  return g.min === g.max ? `${g.min}명` : `${g.min}~${g.max}명`;
}

// ---------- 방 접속 ----------
function enterRoom(code) {
  S.code = code;
  S.leaving = false;
  S.retry = 0;
  S.chat = [];
  S.room = null;
  S.game = null;
  history.replaceState(null, "", `?room=${code}`);
  $("#home").hidden = true;
  $("#room").hidden = false;
  $("#room-code").textContent = code;
  $("#chat-log").replaceChildren();
  $("#stage").replaceChildren(h("div", { class: "card center muted" }, "접속하는 중…"));
  connect();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${S.code}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    S.retry = 0;
    $("#conn-banner").hidden = true;
    send({ t: "hello", pid: store.getPid(S.code), name: myName() || store.get("pg_name") || "손님" });
    clearInterval(S.pingTimer);
    S.pingTimer = setInterval(() => send({ t: "ping" }), 25000);
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = (e) => {
    if (S.ws !== ws) return;
    clearInterval(S.pingTimer);
    if (S.leaving) return;
    if (e.code === 4000) {
      $("#conn-banner").textContent = "다른 창에서 이 방에 다시 들어왔어요. 이 창은 멈췄어요.";
      $("#conn-banner").hidden = false;
      return;
    }
    if (e.code === 4001) {
      toast("방이 가득 찼어요");
      return leaveRoom();
    }
    $("#conn-banner").textContent = "연결이 끊겼어요. 다시 연결하는 중…";
    $("#conn-banner").hidden = false;
    const wait = Math.min(8000, 500 * 2 ** S.retry++);
    setTimeout(() => !S.leaving && S.ws === ws && connect(), wait);
  };
}

function send(msg) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(msg));
}

function act(a) {
  send({ t: "act", a });
}

function leaveRoom() {
  S.leaving = true;
  clearInterval(S.pingTimer);
  try {
    S.ws && S.ws.close();
  } catch {}
  S.ws = null;
  history.replaceState(null, "", location.pathname);
  $("#room").hidden = true;
  $("#home").hidden = false;
}

$("#leave").addEventListener("click", () => {
  if (S.room?.phase === "playing" && isParticipant() && !confirm("게임 중이에요. 정말 나갈까요?")) return;
  leaveRoom();
});

$("#share").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}?room=${S.code}`;
  const text = `🎲 같이 게임하자! 방 코드: ${S.code}`;
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ title: "친구랑 파티 게임", text, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    toast("초대 링크를 복사했어요");
  } catch {
    prompt("이 링크를 친구에게 보내 주세요", url);
  }
});

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#chat-input").value.trim();
  if (!v) return;
  send({ t: "chat", text: v });
  $("#chat-input").value = "";
});

function onMessage(m) {
  if (m.t === "welcome") {
    S.pid = m.pid;
    S.games = m.games;
    store.setPid(S.code, m.pid);
    S.chat = m.chat || [];
    renderChat(true);
  } else if (m.t === "state") {
    S.room = m.room;
    S.game = m.game;
    S.receivedAt = Date.now();
    render();
  } else if (m.t === "chat") {
    S.chat.push(m.c);
    if (S.chat.length > 60) S.chat.shift();
    renderChat(false, m.c);
  } else if (m.t === "error") {
    toast(m.msg);
  }
}

// ---------- 그리기 ----------
const isHost = () => S.room && S.room.hostId === S.pid;
const me = () => S.room?.players.find((p) => p.id === S.pid);
const isParticipant = () => !!S.game?.participants.includes(S.pid);
const gameInfo = (id) => S.games.find((g) => g.id === id);
const nameOf = (id) => S.room?.players.find((p) => p.id === id)?.name ?? "?";

function render() {
  renderPlayers();
  if (S.room.phase === "lobby") renderLobby();
  else renderGame();
}

function renderPlayers() {
  const ps = S.room.players;
  const seated = ps.filter((p) => !p.spectator).length;
  $("#player-count").textContent = `${ps.length}명 · 자리 ${seated}/${S.room.size}`;
  $("#players").replaceChildren(
    ...ps.map((p) =>
      h(
        "li",
        { class: `player${p.connected ? "" : " off"}${p.id === S.pid ? " me" : ""}` },
        h("span", { class: "avatar", style: `--hue:${hue(p.name)}` }, p.name.slice(0, 1)),
        h("span", { class: "pname" }, p.name, p.id === S.pid ? h("small", null, " (나)") : null),
        p.id === S.room.hostId ? h("span", { title: "방장" }, "👑") : null,
        p.wins ? h("span", { class: "wins", title: "이 방에서 이긴 횟수" }, `🏆${p.wins}`) : null,
        h("span", { class: `tag ${p.spectator && !p.playing ? "spec" : "seat"}` }, !p.connected ? "끊김" : S.room.phase !== "lobby" ? (p.playing ? "게임 중" : "관전") : p.spectator ? "관전" : "참가")
      )
    )
  );
}

function hue(s) {
  let x = 0;
  for (const ch of s) x = (x * 31 + ch.codePointAt(0)) % 360;
  return x;
}

function renderLobby() {
  const room = S.room;
  const host = isHost();
  const g = gameInfo(room.gameId);
  const seatedOnline = room.players.filter((p) => !p.spectator && p.connected).length;
  const mine = me();

  const picker = h(
    "div",
    { class: "game-grid" },
    S.games.map((x) =>
      h(
        "button",
        {
          class: `game-card${x.id === room.gameId ? " on" : ""}`,
          disabled: !host && x.id !== room.gameId,
          onclick: () => host && send({ t: "config", game: x.id }),
        },
        h("span", { class: "emoji" }, x.emoji),
        h("b", null, x.name),
        h("span", { class: "pill" }, people(x))
      )
    )
  );

  const sizes = [];
  for (let n = g.min; n <= g.max; n++) sizes.push(n);
  const sizePicker = h(
    "div",
    { class: "sizes" },
    sizes.map((n) =>
      h(
        "button",
        { class: `size${n === room.size ? " on" : ""}`, disabled: !host, onclick: () => send({ t: "config", size: n }) },
        `${n}명`
      )
    )
  );

  let status;
  if (seatedOnline < g.min) status = `${g.min - seatedOnline}명 더 필요해요 (지금 ${seatedOnline}명)`;
  else status = `${seatedOnline}명이 준비됐어요!`;

  $("#stage").replaceChildren(
    h(
      "div",
      { class: "card" },
      h("h2", null, host ? "게임 고르기" : "방장이 게임을 고르고 있어요"),
      picker
    ),
    h(
      "div",
      { class: "card selected" },
      h("div", { class: "sel-head" }, h("span", { class: "emoji big" }, g.emoji), h("div", null, h("h2", null, g.name), h("p", { class: "muted" }, g.short))),
      h("ul", { class: "rules" }, g.rules.map((r) => h("li", null, r))),
      g.min !== g.max
        ? [h("h3", null, "인원 선택 ", h("span", { class: "muted" }, host ? "(참가할 자리 수)" : "(방장이 정해요)")), sizePicker]
        : h("p", { class: "muted" }, `이 게임은 ${g.min}명이서 해요.`),
      h(
        "div",
        { class: "lobby-actions" },
        mine &&
          h(
            "button",
            { class: "btn ghost", onclick: () => send({ t: "seat", spectator: !mine.spectator }) },
            mine.spectator ? "🙋 참가하기" : "👀 관전하기"
          ),
        host
          ? h("button", { class: "btn primary big", disabled: seatedOnline < g.min, onclick: () => send({ t: "start" }) }, "▶ 게임 시작")
          : h("span", { class: "muted" }, "방장이 시작하면 바로 게임이 열려요"),
        h("p", { class: "status" }, status)
      )
    )
  );
}

function renderGame() {
  const stage = $("#stage");
  const g = gameInfo(S.game.id);
  // 다시 그려도 쓰던 글자와 커서가 사라지지 않게
  const active = document.activeElement;
  const keepId = active && stage.contains(active) && active.id ? active.id : null;
  const kept = {};
  for (const el of stage.querySelectorAll("input[id]")) kept[el.id] = el.value;

  const ctx = {
    me: S.pid,
    playing: isParticipant(),
    act,
    name: nameOf,
    receivedAt: S.receivedAt,
    cd: (ms) => countdown(ms, S.receivedAt),
    over: S.game.over,
  };
  const body = RENDER[S.game.id](S.game.view, ctx);

  const head = h(
    "div",
    { class: "game-head" },
    h("span", { class: "emoji" }, g.emoji),
    h("h2", null, g.name),
    !ctx.playing ? h("span", { class: "tag spec" }, "관전 중") : null,
    isHost() && S.room.phase === "playing"
      ? h("button", { class: "btn ghost small", onclick: () => confirm("게임을 멈추고 로비로 갈까요?") && send({ t: "lobby" }) }, "그만하기")
      : null
  );

  let result = null;
  if (S.room.phase === "result" && S.game.over) {
    const o = S.game.over;
    const iWon = o.winners?.includes(S.pid);
    const iLost = o.losers?.includes(S.pid);
    result = h(
      "div",
      { class: `card result${iWon ? " win" : iLost ? " lose" : ""}` },
      h("div", { class: "result-title" }, iWon ? "🎉 승리!" : iLost ? "😭 아쉬워요!" : "게임 끝"),
      h("p", { class: "result-text" }, o.text),
      o.winners?.length ? h("p", { class: "muted" }, "이긴 사람: ", o.winners.map(nameOf).join(", ")) : null,
      isHost()
        ? h(
            "div",
            { class: "row" },
            h("button", { class: "btn primary", onclick: () => send({ t: "start" }) }, "🔁 한 번 더"),
            h("button", { class: "btn", onclick: () => send({ t: "lobby" }) }, "🎮 다른 게임")
          )
        : h("p", { class: "muted" }, "방장이 다음 게임을 고르는 중…")
    );
  }

  stage.replaceChildren(...[result, h("div", { class: "card game" }, head, body)].filter(Boolean));

  for (const [id, v] of Object.entries(kept)) {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = v;
  }
  if (keepId) document.getElementById(keepId)?.focus();
}

function renderChat(all, c) {
  const log = $("#chat-log");
  const item = (c) =>
    h("li", { class: c.sys ? "sys" : c.pid === S.pid ? "mine" : "" }, c.sys ? c.text : [h("b", null, c.name), " ", c.text]);
  if (all) log.replaceChildren(...S.chat.map(item));
  else if (c) log.append(item(c));
  while (log.children.length > 60) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

setInterval(tickCountdowns, 200);

// 초대 링크로 들어왔으면 방 코드를 채워 둔다
const invited = new URLSearchParams(location.search).get("room");
if (invited && /^[A-Za-z0-9]{4}$/.test(invited)) {
  const code = invited.toUpperCase();
  $("#code").value = code;
  if (myName()) enterRoom(code);
  else {
    toast("이름을 적고 '들어가기'를 눌러 주세요");
    $("#name").focus();
  }
}
