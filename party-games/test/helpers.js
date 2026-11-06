// 시간과 타이머를 마음대로 돌릴 수 있는 가짜 환경
export function fakeClock(seed = 1) {
  let t = 1_000_000;
  let id = 0;
  const timers = new Map();
  let x = seed;
  const random = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  return {
    now: () => t,
    random,
    setTimer(fn, ms) {
      const h = ++id;
      timers.set(h, { at: t + ms, fn });
      return h;
    },
    clearTimer(h) {
      timers.delete(h);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [h, v] of timers) if (v.at <= end && (!next || v.at < next[1].at)) next = [h, v];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
  };
}

// 게임 하나만 따로 돌리는 ctx
export function gameCtx(clock) {
  return {
    now: clock.now,
    random: clock.random,
    schedule: (ms, key) => clock.setTimer(() => clock.onTimer && clock.onTimer(key), ms),
  };
}

export function fakeConn() {
  const c = {
    msgs: [],
    closed: null,
    send(s) {
      c.msgs.push(JSON.parse(s));
    },
    close(code) {
      c.closed = code;
    },
    last(t) {
      for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].t === t) return c.msgs[i];
      return null;
    },
  };
  return c;
}
