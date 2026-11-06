// 오목: 15×15 판에서 가로·세로·대각선으로 다섯 개를 먼저 잇는 사람이 이긴다.
import { shuffle, nameMap } from "./util.js";

const N = 15;
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

function lineLen(board, x, y, dx, dy, c) {
  let n = 1;
  for (const sgn of [1, -1]) {
    let cx = x + dx * sgn, cy = y + dy * sgn;
    while (cx >= 0 && cy >= 0 && cx < N && cy < N && board[cy * N + cx] === c) {
      n++;
      cx += dx * sgn;
      cy += dy * sgn;
    }
  }
  return n;
}

export default {
  id: "omok",
  name: "오목",
  emoji: "⚫",
  min: 2,
  max: 2,
  short: "다섯 알을 먼저 한 줄로 잇는 사람이 승리!",
  rules: [
    "흑이 먼저 두고, 번갈아 한 알씩 놓습니다.",
    "가로·세로·대각선으로 다섯 알 이상을 먼저 이으면 이겨요.",
    "기권 버튼으로 항복할 수 있어요.",
  ],
  setup(players, ctx) {
    return {
      order: shuffle(players.map((p) => p.id), ctx.random), // [흑, 백]
      names: nameMap(players),
      board: new Array(N * N).fill(0),
      turn: 0,
      last: null,
      moves: 0,
      over: null,
    };
  },
  action(s, pid, a) {
    if (s.over) return "게임이 끝났어요";
    const me = s.order.indexOf(pid);
    if (a && a.type === "resign") {
      const other = s.order[1 - me];
      s.over = { winners: [other], losers: [pid], text: `${s.names[pid]}님이 기권했어요. ${s.names[other]}님 승리!` };
      return;
    }
    if (!a || a.type !== "place") return "알 수 없는 동작";
    if (me !== s.turn) return "내 차례가 아니에요";
    const x = Number(a.x), y = Number(a.y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= N || y >= N) return "판 밖이에요";
    if (s.board[y * N + x]) return "이미 돌이 있어요";
    const c = me + 1;
    s.board[y * N + x] = c;
    s.last = { x, y };
    s.moves++;
    if (DIRS.some(([dx, dy]) => lineLen(s.board, x, y, dx, dy, c) >= 5)) {
      s.over = { winners: [pid], losers: [s.order[1 - me]], text: `${s.names[pid]}님(${c === 1 ? "흑" : "백"}) 오목 완성! 🎉` };
      return;
    }
    if (s.moves >= N * N) {
      s.over = { winners: [], losers: [], text: "판이 가득 찼어요. 무승부!" };
      return;
    }
    s.turn = 1 - s.turn;
  },
  timer() {},
  view(s) {
    return {
      size: N,
      board: s.board,
      black: { id: s.order[0], name: s.names[s.order[0]] },
      white: { id: s.order[1], name: s.names[s.order[1]] },
      turnId: s.over ? null : s.order[s.turn],
      last: s.last,
    };
  },
};
