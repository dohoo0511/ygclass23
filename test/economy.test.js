/*
 * 경제 균형 테스트
 *
 * 실행:  node test/economy.test.js
 *
 * index.html 의 실제 설정값과 주식 엔진을 그대로 불러와, 파이가 끝없이
 * 불어나는 구멍이 다시 생기지 않았는지 확인합니다. 저장소에는 접속하지 않습니다.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

/* 브라우저 흉내 (화면은 쓰지 않고 계산 함수만 꺼내 씀) */
const stub = () => ({ addEventListener(){}, style:{}, classList:{add(){},remove(){},contains:()=>false},
    textContent:'', innerHTML:'', value:'', disabled:false, appendChild(){}, remove(){}, querySelectorAll:()=>[], children:[] });
global.document = { getElementById: stub, createElement: stub, addEventListener(){}, body: stub(), querySelectorAll: () => [], visibilityState: 'visible' };
global.window = { addEventListener(){}, innerWidth: 400 };
global.location = { protocol: 'https:', hostname: 'x.pages.dev' };
global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
global.alert = () => {}; global.confirm = () => true;
global.fetch = async () => { throw new Error('no net'); };
global.setInterval = () => 0; global.setTimeout = () => 0;

const app = {};
eval(script + `
  app.initStock = initStockMarket; app.applyTicks = applyStockTicks; app.setDb = v => { db = v; };
  app.COMPANIES = COMPANIES; app.holdingOf = holdingOf; app.buyableQty = buyableQty;
  app.totalHeldQty = totalHeldQty; app.savingsPayout = savingsPayout; app.savingsRatePct = savingsRatePct;
  app.K = { MIN: STOCK_MIN_PRICE, LOCK: STOCK_BUY_LOCK_PRICE, PER: STOCK_MAX_HOLD_PER_COMPANY,
            TOTAL: STOCK_MAX_HOLD_TOTAL, ORDER: STOCK_MAX_ORDER, DIV: DIVIDEND_RATE_PCT,
            LOTTO_MAX: LOTTO_NUMBER_MAX, TERMS: SAVINGS_TERM_WEEKS };
`);

const results = [];
const check = (name, cond) => results.push([name, !!cond]);
const DAY = 24 * 3600 * 1000;
const C = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return Math.round(r); };

/* ── 적금: 기간이 길어져도 수익률이 폭주하지 않아야 함 ── */
const yields = app.K.TERMS.map(w => app.savingsPayout({ principal: 100, weeks: w, weeklyRatePct: app.savingsRatePct(w) }) / 100 - 1);
check('8주 적금 수익률이 30% 미만 (예전 160%)', yields[yields.length - 1] < 0.30);
check('적금 이율이 기간에 비례해 커지지 않음 (제곱 증가 없음)',
    app.savingsRatePct(2) === app.savingsRatePct(8));
check('그래도 기간이 길수록 이득', yields[yields.length - 1] > yields[0]);

/* ── 로또 ──
   drawLotto 의 실제 분배: 누적 상금(Pot)의 40% 는 1등, 30% 는 2등.
   당첨자가 없는 몫만 다음 회차로 이월되고, 나머지 30% 는 지급도 이월도 되지 않고 사라진다.
   그래서 로또는 파이를 만드는 쪽이 아니라 없애는 쪽이어야 정상이다.
   (한때 "회수율 125%" 로 잘못 계산했는데, Pot 의 70% 가 매번 돌아온다고 본 탓이었다) */
const N = app.K.LOTTO_MAX, T = C(N, 5), p = m => C(5, m) * C(N - 5, 5 - m) / T;
const TICKETS = 300;                              // 학생 30명이 주 10장씩 산다고 보고
const revenue = TICKETS * 4;
const noneOf = m => Math.pow(1 - p(m), TICKETS);  // 그 등수 당첨자가 한 명도 없을 확률
const rollFrac = 0.4 * noneOf(5) + 0.3 * noneOf(4);
const pot = revenue / (1 - rollFrac);             // 이월이 쌓이다 멈추는 지점
const paidCash = 0.4 * pot * (1 - noneOf(5)) + 0.3 * pot * (1 - noneOf(4))
    + TICKETS * (p(5) * 22 + p(4) * 13);          // 기본 상금은 Pot 과 별개로 지급
const netCash = paidCash - revenue;
const coupons = TICKETS * (p(3) + p(2));          // 3·4등으로 공짜로 풀리는 쿠폰

check(`로또가 파이를 늘리지 않음 — 주 ${netCash.toFixed(0)}π`, netCash <= 0);
check(`누적 상금이 끝없이 불어나지 않음 — ${pot.toFixed(0)}π 에서 멈춤`, pot < 10000);
check(`쿠폰 살포가 주 100장 미만 — ${coupons.toFixed(0)}장 (상점 수요를 죽이지 않을 것)`, coupons < 100);

/* ── 주식 보유 한도 ── */
const user = { pi: 100000, stocks: {} };
check('처음엔 전체 한도만큼 살 수 있음', app.buyableQty(user, 'taehoon') === app.K.TOTAL);
user.stocks.taehoon = [{ q: app.K.PER, cost: 100, at: 0, paid: 0 }];
check('한 회사를 한도까지 채우면 그 회사는 더 못 삼', app.buyableQty(user, 'taehoon') === 0);
check('전체 한도도 함께 걸림', app.buyableQty(user, 'ttaek') === Math.max(0, app.K.TOTAL - app.K.PER));
user.stocks.taehoon = [{ q: 3, cost: 30, at: 0, paid: 0 }];
user.stocks.ttaek = [{ q: 4, cost: 40, at: 0, paid: 0 }];
check('여러 회사에 나눠 가져도 합계로 계산', app.totalHeldQty(user) === 7);
check('남은 만큼만 더 살 수 있음', app.buyableQty(user, 'dohoo') === app.K.TOTAL - 7);
check('1회 주문 한도가 보유 한도를 넘지 않음', app.K.ORDER <= app.K.TOTAL);

/* ── 최저가에서 사는 것을 막는 설정이 살아 있는가 ── */
check('최저가 매수 잠금값이 최저가 이상', app.K.LOCK >= app.K.MIN);

/* ── 배당: 손실 없는 수입이라 낮아야 함 ── */
check(`배당률 1% 이하 — 현재 ${app.K.DIV}%`, app.K.DIV <= 1);
const held = app.K.TOTAL, price = 16;
const weekly = Math.round(price * app.K.DIV / 100 * held) / 2;
check(`학생 1명이 한도까지 들고 있어도 배당은 주 ${weekly.toFixed(1)}π 이하`, weekly <= 1);

/* ── 뉴스 엔진은 여전히 되돌아와야 함 (한쪽으로 흐르면 안 됨) ── */
let startSum = 0, endSum = 0;
for (let r = 0; r < 20; r++) {
    const t0 = Date.UTC(2026, 0, 5);
    const d = { users: {}, stocks: null };
    app.setDb(d);
    d.stocks = app.initStock(t0);
    d.stocks.seed += r * 7919;
    app.applyTicks(t0 + 60 * DAY);
    app.COMPANIES.forEach(c => { startSum += c.startPrice; endSum += d.stocks.companies[c.id].price; });
}
const drift = endSum / startSum - 1;
check(`뉴스만으로는 주가가 한쪽으로 쏠리지 않음 (60일 ${(drift * 100).toFixed(1)}%)`, Math.abs(drift) < 0.25);

console.log('\n' + results.map(([n, ok]) => `  ${ok ? '통과' : '실패'}  ${n}`).join('\n'));
const failed = results.filter(x => !x[1]).length;
console.log(failed === 0 ? `\n전부 통과 (${results.length}개)\n` : `\n${failed}개 실패 / 전체 ${results.length}개\n`);
process.exit(failed === 0 ? 0 : 1);
