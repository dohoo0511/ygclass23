import test from "node:test";
import assert from "node:assert/strict";
import { RoomCore } from "../src/room-core.js";
import { fakeClock, fakeConn } from "./helpers.js";

function room() {
  const clock = fakeClock(7);
  const r = new RoomCore(clock);
  r.code = "ABCD";
  return { r, clock };
}

function join(r, name, pid) {
  const c = fakeConn();
  r.message(c, JSON.stringify({ t: "hello", name, pid }));
  c.pid = c.last("welcome")?.pid;
  return c;
}

const say = (r, c, m) => r.message(c, JSON.stringify(m));
const state = (c) => c.last("state");

test("처음 들어온 사람이 방장, 이름이 겹치면 번호를 붙인다", () => {
  const { r } = room();
  const a = join(r, "민수");
  const b = join(r, "민수");
  assert.equal(state(a).room.hostId, a.pid);
  assert.deepEqual(state(b).room.players.map((p) => p.name), ["민수", "민수2"]);
});

test("인원 선택: 자리보다 많이 들어오면 관전, 자리를 늘리면 다시 앉는다", () => {
  const { r } = room();
  const a = join(r, "A");
  say(r, a, { t: "config", game: "br31" });
  say(r, a, { t: "config", size: 2 });
  assert.equal(r.size, 2);
  join(r, "B");
  const c = join(r, "C");
  let ps = state(c).room.players;
  assert.deepEqual(ps.map((p) => p.spectator), [false, false, true]);
  say(r, a, { t: "config", size: 3 });
  ps = state(c).room.players;
  assert.deepEqual(ps.map((p) => p.spectator), [false, false, false]);
  // 자리를 줄이면 늦게 온 사람이 관전으로
  say(r, a, { t: "config", size: 2 });
  assert.equal(state(c).room.players[2].spectator, true);
});

test("게임이 허용하는 인원 범위를 벗어난 자리 수는 맞춰진다", () => {
  const { r } = room();
  const a = join(r, "A");
  say(r, a, { t: "config", game: "omok", size: 6 });
  assert.equal(r.size, 2);
  say(r, a, { t: "config", game: "liar" });
  say(r, a, { t: "config", size: 1 });
  assert.equal(r.size, 3);
});

test("방장만 설정과 시작을 할 수 있고, 최소 인원이 있어야 시작된다", () => {
  const { r } = room();
  const a = join(r, "A");
  const b = join(r, "B");
  say(r, b, { t: "config", game: "omok" });
  assert.equal(b.last("error").msg, "방장만 바꿀 수 있어요");
  say(r, a, { t: "config", game: "liar" });
  say(r, a, { t: "start" });
  assert.match(a.last("error").msg, /3명 이상/);
  join(r, "C");
  say(r, a, { t: "start" });
  assert.equal(r.phase, "playing");
  assert.equal(state(b).game.id, "liar");
});

test("관전자는 게임에 참여하지 못한다", () => {
  const { r } = room();
  const a = join(r, "A");
  const b = join(r, "B");
  const c = join(r, "C");
  say(r, a, { t: "config", game: "br31" });
  say(r, c, { t: "seat", spectator: true });
  say(r, a, { t: "start" });
  assert.deepEqual(r.game.participants, [a.pid, b.pid]);
  say(r, c, { t: "act", a: { type: "say", n: 1 } });
  assert.equal(c.last("error").msg, "관전 중이에요");
});

test("게임이 끝나면 결과가 나오고 이긴 횟수가 쌓인다, 다시 하기도 된다", () => {
  const { r } = room();
  const a = join(r, "A");
  const b = join(r, "B");
  say(r, a, { t: "config", game: "omok" });
  say(r, a, { t: "start" });
  const [black] = r.game.participants;
  const blackConn = black === a.pid ? a : b;
  say(r, blackConn, { t: "act", a: { type: "resign" } });
  assert.equal(r.phase, "result");
  const winner = state(a).room.players.find((p) => p.id !== black);
  assert.equal(winner.wins, 1);
  say(r, a, { t: "start" });
  assert.equal(r.phase, "playing");
  say(r, a, { t: "lobby" });
  assert.equal(r.phase, "lobby");
  assert.equal(r.game, null);
});

test("게임 타이머가 돌아가고, 로비로 가면 멈춘다", () => {
  const { r, clock } = room();
  const a = join(r, "A");
  join(r, "B");
  say(r, a, { t: "config", game: "br31" });
  say(r, a, { t: "start" });
  clock.advance(15000);
  assert.equal(r.game.state.count, 1);
  say(r, a, { t: "lobby" });
  clock.advance(60000);
  assert.equal(r.phase, "lobby");
});

test("새로고침해도 같은 자리로 돌아온다", () => {
  const { r, clock } = room();
  const a = join(r, "A");
  join(r, "B");
  r.disconnect(a);
  clock.advance(5000);
  const a2 = join(r, "A", a.pid);
  assert.equal(a2.pid, a.pid);
  assert.equal(r.players.length, 2);
  assert.equal(state(a2).room.hostId, a.pid);
  clock.advance(30000);
  assert.equal(r.players.length, 2, "다시 들어왔으니 지우지 않음");
});

test("방장이 나가면 다음 사람이 방장이 된다", () => {
  const { r, clock } = room();
  const a = join(r, "A");
  const b = join(r, "B");
  r.disconnect(a);
  clock.advance(25000);
  assert.equal(r.players.length, 1);
  assert.equal(state(b).room.hostId, b.pid);
});

test("게임 중에 끊긴 참가자는 게임이 끝날 때까지 자리를 지킨다", () => {
  const { r, clock } = room();
  const a = join(r, "A");
  const b = join(r, "B");
  say(r, a, { t: "config", game: "omok" });
  say(r, a, { t: "start" });
  r.disconnect(b);
  clock.advance(25000);
  assert.equal(r.players.length, 2);
  say(r, a, { t: "lobby" });
  assert.equal(r.players.length, 1);
});

test("게임 중에 들어온 사람은 관전부터, 다음 판에는 자리가 있으면 앉는다", () => {
  const { r } = room();
  const a = join(r, "A");
  join(r, "B");
  say(r, a, { t: "config", game: "br31" });
  say(r, a, { t: "start" });
  const c = join(r, "C");
  assert.equal(state(c).room.players[2].spectator, true);
  assert.equal(state(c).game.view.order.length, 2);
  say(r, a, { t: "lobby" });
  assert.equal(state(c).room.players[2].spectator, false);
});

test("다른 사람에게 비밀이 새지 않는다 (라이어)", () => {
  const { r } = room();
  const conns = [join(r, "A"), join(r, "B"), join(r, "C"), join(r, "D")];
  say(r, conns[0], { t: "start" });
  const s = r.game.state;
  const liar = conns.find((c) => c.pid === s.liar);
  assert.ok(!JSON.stringify(state(liar)).includes(s.word));
});

test("채팅", () => {
  const { r } = room();
  const a = join(r, "A");
  const b = join(r, "B");
  say(r, a, { t: "chat", text: "  안녕  " });
  assert.equal(b.last("chat").c.text, "안녕");
  const c = join(r, "C");
  assert.ok(c.last("welcome").chat.some((x) => x.text === "안녕"));
});

test("이상한 메시지는 무시한다", () => {
  const { r } = room();
  const a = join(r, "A");
  r.message(a, "not json");
  r.message(a, "null");
  say(r, a, { t: "act", a: null });
  const stranger = fakeConn();
  say(r, stranger, { t: "start" });
  assert.equal(r.phase, "lobby");
});
