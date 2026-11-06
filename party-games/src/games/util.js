// 게임들이 같이 쓰는 작은 도구
export function shuffle(arr, random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function pick(arr, random) {
  return arr[Math.floor(random() * arr.length)];
}

export function nameMap(players) {
  const m = {};
  for (const p of players) m[p.id] = p.name;
  return m;
}

// 차례 제한 시간을 새로 건다. token 이 바뀌면 예전 타이머는 무시된다.
export function arm(s, ctx, ms, prefix = "turn") {
  s.token = (s.token || 0) + 1;
  s.deadline = ctx.now() + ms;
  ctx.schedule(ms, `${prefix}:${s.token}`);
}

export function remain(s, ctx) {
  return s.deadline ? Math.max(0, s.deadline - ctx.now()) : 0;
}

export function isTimer(s, key, prefix = "turn") {
  return key === `${prefix}:${s.token}`;
}
