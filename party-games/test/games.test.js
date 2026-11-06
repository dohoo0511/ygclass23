import test from "node:test";
import assert from "node:assert/strict";
import { GAMES } from "../src/games/index.js";
import { fakeClock, gameCtx } from "./helpers.js";

const players = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

function run(gameId, n, seed = 1) {
  const clock = fakeClock(seed);
  const ctx = gameCtx(clock);
  const g = GAMES[gameId];
  const s = g.setup(players(n), ctx);
  clock.onTimer = (key) => g.timer(s, key, ctx);
  return { g, s, ctx, clock };
}

test("모든 게임 정보가 올바르다", () => {
  for (const g of Object.values(GAMES)) {
    assert.ok(g.min >= 2 && g.max >= g.min && g.max <= 8, g.id);
    assert.ok(g.name && g.emoji && g.rules.length, g.id);
  }
});

test("베스킨라빈스: 31을 말한 사람이 진다", () => {
  const { g, s, ctx } = run("br31", 3);
  assert.equal(g.action(s, s.order[1], { type: "say", n: 1 }, ctx), "내 차례가 아니에요");
  assert.ok(g.action(s, s.order[0], { type: "say", n: 4 }, ctx));
  while (!s.over) g.action(s, s.order[s.turn], { type: "say", n: 3 }, ctx);
  assert.equal(s.count, 31);
  const loser = s.history.at(-1).pid;
  assert.deepEqual(s.over.losers, [loser]);
  assert.equal(s.over.winners.length, 2);
});

test("베스킨라빈스: 시간이 지나면 숫자 1개를 자동으로 말한다", () => {
  const { s, clock } = run("br31", 2);
  clock.advance(15000);
  assert.equal(s.count, 1);
  assert.equal(s.history[0].auto, true);
  assert.equal(s.turn, 1);
});

test("업다운: 범위 밖은 거절, 폭탄을 고르면 진다", () => {
  const { g, s, ctx } = run("updown", 2);
  const p0 = s.order[0];
  assert.ok(g.action(s, p0, { type: "guess", n: 0 }, ctx));
  assert.ok(g.action(s, p0, { type: "guess", n: 101 }, ctx));
  const notSecret = s.secret === 50 ? 51 : 50;
  g.action(s, p0, { type: "guess", n: notSecret }, ctx);
  assert.ok(s.lo === notSecret || s.hi === notSecret);
  const p1 = s.order[1];
  g.action(s, p1, { type: "guess", n: s.secret }, ctx);
  assert.deepEqual(s.over.losers, [p1]);
  assert.equal(g.view(s, p0, ctx).secret, s.secret);
});

test("업다운: 폭탄 숫자는 끝나기 전엔 보이지 않는다", () => {
  const { g, s, ctx } = run("updown", 3);
  assert.equal(g.view(s, "p0", ctx).secret, null);
  assert.ok(!JSON.stringify(g.view(s, "p0", ctx)).includes('"secret":' + s.secret));
});

test("오목: 다섯 개를 이으면 이긴다", () => {
  const { g, s, ctx } = run("omok", 2);
  const [b, w] = s.order;
  for (let i = 0; i < 4; i++) {
    assert.equal(g.action(s, b, { type: "place", x: i, y: 0 }, ctx), undefined);
    assert.equal(g.action(s, w, { type: "place", x: i, y: 1 }, ctx), undefined);
  }
  assert.equal(g.action(s, w, { type: "place", x: 9, y: 9 }, ctx), "내 차례가 아니에요");
  assert.equal(g.action(s, b, { type: "place", x: 0, y: 0 }, ctx), "이미 돌이 있어요");
  g.action(s, b, { type: "place", x: 4, y: 0 }, ctx);
  assert.deepEqual(s.over.winners, [b]);
});

test("오목: 대각선과 기권", () => {
  const { g, s, ctx } = run("omok", 2);
  const [b, w] = s.order;
  for (let i = 0; i < 4; i++) {
    g.action(s, b, { type: "place", x: 10 - i, y: i }, ctx);
    g.action(s, w, { type: "place", x: 0, y: 14 - i }, ctx);
  }
  g.action(s, b, { type: "place", x: 6, y: 4 }, ctx);
  assert.deepEqual(s.over.winners, [b]);
  const r = run("omok", 2);
  r.g.action(r.s, r.s.order[0], { type: "resign" }, r.ctx);
  assert.deepEqual(r.s.over.winners, [r.s.order[1]]);
});

test("가위바위보: 진 쪽이 탈락하고, 마지막 한 명이 이긴다", () => {
  const { g, s, ctx, clock } = run("rps", 3);
  g.action(s, "p0", { type: "pick", hand: "rock" }, ctx);
  g.action(s, "p1", { type: "pick", hand: "rock" }, ctx);
  g.action(s, "p2", { type: "pick", hand: "scissors" }, ctx);
  assert.deepEqual(s.alive, ["p0", "p1"]);
  assert.equal(s.phase, "reveal");
  assert.ok(g.action(s, "p0", { type: "pick", hand: "rock" }, ctx));
  clock.advance(3000);
  assert.equal(s.phase, "pick");
  assert.equal(g.action(s, "p2", { type: "pick", hand: "rock" }, ctx), "이미 탈락했어요");
  g.action(s, "p0", { type: "pick", hand: "paper" }, ctx);
  g.action(s, "p1", { type: "pick", hand: "paper" }, ctx);
  assert.equal(s.last.out.length, 0, "같은 것만 나오면 비김");
  clock.advance(3000);
  g.action(s, "p0", { type: "pick", hand: "paper" }, ctx);
  g.action(s, "p1", { type: "pick", hand: "scissors" }, ctx);
  assert.deepEqual(s.over.winners, ["p1"]);
});

test("가위바위보: 시간 안에 안 내면 자동으로 낸다", () => {
  const { g, s, ctx, clock } = run("rps", 2);
  g.action(s, "p0", { type: "pick", hand: "rock" }, ctx);
  clock.advance(10000);
  assert.ok(s.last.auto.includes("p1"));
  // 남의 손은 내기 전엔 보이지 않는다
  const r = run("rps", 2);
  r.g.action(r.s, "p0", { type: "pick", hand: "rock" }, r.ctx);
  const v = r.g.view(r.s, "p1", r.ctx);
  assert.equal(v.myPick, null);
  assert.ok(!JSON.stringify(v).includes("rock"));
});

test("반응속도: 먼저 누르면 실격, 가장 빠른 사람이 점수를 얻는다", () => {
  const { g, s, ctx, clock } = run("reaction", 3);
  g.action(s, "p0", { type: "tap", ms: 0 }, ctx);
  assert.deepEqual(s.falses, ["p0"]);
  while (s.phase === "wait") clock.advance(10);
  assert.equal(s.phase, "go");
  clock.advance(300);
  g.action(s, "p1", { type: "tap", ms: 250 }, ctx);
  g.action(s, "p2", { type: "tap", ms: 280 }, ctx);
  assert.equal(s.phase, "reveal");
  assert.equal(s.scores.p1, 1);
  // 남은 판을 모두 시간 초과로 넘기면 끝난다
  for (let i = 0; i < 10 && !s.over; i++) clock.advance(10000);
  assert.ok(s.over);
  assert.deepEqual(s.over.winners, ["p1"]);
});

test("반응속도: 기기가 잰 시간이 서버가 본 시간보다 클 수는 없다", () => {
  const { g, s, ctx, clock } = run("reaction", 2);
  while (s.phase === "wait") clock.advance(10);
  clock.advance(200);
  g.action(s, "p0", { type: "tap", ms: 99999 }, ctx);
  assert.ok(s.times.p0 <= 260, String(s.times.p0));
});

test("눈치 게임: 동시에 외치면 둘 다 진다", () => {
  const { g, s, ctx, clock } = run("nunchi", 4);
  assert.ok(g.action(s, "p0", { type: "shout" }, ctx), "준비 중엔 못 외침");
  clock.advance(3000);
  g.action(s, "p0", { type: "shout" }, ctx);
  clock.advance(1000);
  g.action(s, "p1", { type: "shout" }, ctx);
  clock.advance(200);
  g.action(s, "p2", { type: "shout" }, ctx);
  assert.deepEqual(s.over.losers.sort(), ["p1", "p2"]);
});

test("눈치 게임: 마지막까지 못 외친 사람이 진다", () => {
  const { g, s, ctx, clock } = run("nunchi", 3);
  clock.advance(3000);
  g.action(s, "p2", { type: "shout" }, ctx);
  clock.advance(1000);
  assert.ok(g.action(s, "p2", { type: "shout" }, ctx));
  g.action(s, "p0", { type: "shout" }, ctx);
  assert.equal(s.over, null);
  clock.advance(1000);
  assert.deepEqual(s.over.losers, ["p1"]);
});

function liarToVote(n) {
  const r = run("liar", n);
  const { g, s, ctx } = r;
  while (s.phase === "hint") g.action(s, s.order[s.hintIdx % n], { type: "hint", text: "음" }, ctx);
  return r;
}

test("라이어: 라이어만 제시어를 모른다", () => {
  const { g, s, ctx } = run("liar", 4);
  for (const id of s.order) {
    const v = g.view(s, id, ctx);
    if (id === s.liar) {
      assert.equal(v.role, "liar");
      assert.equal(v.word, null);
      assert.ok(!JSON.stringify(v).includes(s.word));
    } else assert.equal(v.word, s.word);
  }
});

test("라이어: 지목된 라이어가 제시어를 맞히면 라이어 승리", () => {
  const { g, s, ctx } = liarToVote(4);
  assert.equal(s.hints.length, 8, "4명 이하면 두 바퀴");
  const others = s.order.filter((id) => id !== s.liar);
  for (const id of others) g.action(s, id, { type: "vote", target: s.liar }, ctx);
  g.action(s, s.liar, { type: "vote", target: others[0] }, ctx);
  assert.equal(s.phase, "guess");
  assert.ok(g.action(s, others[0], { type: "guess", word: s.word }, ctx));
  g.action(s, s.liar, { type: "guess", word: s.word }, ctx);
  assert.deepEqual(s.over.winners, [s.liar]);
});

test("라이어: 엉뚱한 사람을 지목하면 라이어 승리, 틀리게 맞히면 시민 승리", () => {
  const a = liarToVote(5);
  assert.equal(a.s.hints.length, 5);
  const others = a.s.order.filter((id) => id !== a.s.liar);
  for (const id of a.s.order) a.g.action(a.s, id, { type: "vote", target: id === others[0] ? others[1] : others[0] }, a.ctx);
  assert.deepEqual(a.s.over.winners, [a.s.liar]);

  const b = liarToVote(3);
  const cit = b.s.order.filter((id) => id !== b.s.liar);
  for (const id of cit) b.g.action(b.s, id, { type: "vote", target: b.s.liar }, b.ctx);
  b.g.action(b.s, b.s.liar, { type: "vote", target: cit[0] }, b.ctx);
  b.g.action(b.s, b.s.liar, { type: "guess", word: "없는말" }, b.ctx);
  assert.deepEqual(b.s.over.losers, [b.s.liar]);
});

test("라이어: 시간이 지나면 다음 단계로 넘어간다", () => {
  const { s, clock } = run("liar", 3);
  clock.advance(40000 * 6);
  assert.equal(s.phase, "vote");
  clock.advance(60000);
  assert.ok(s.over, "아무도 투표 안 하면 라이어가 빠져나감");
  assert.deepEqual(s.over.winners, [s.liar]);
});
