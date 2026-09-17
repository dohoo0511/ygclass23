/*
 * 주식 주문이 사라지지 않는지 확인하는 테스트
 *
 * 실행:  node test/stock-trade.test.js
 *
 * index.html 의 실제 매매 코드(buyStock / sellStock)를 그대로 불러와,
 * 서버를 흉내 낸 환경에서 '다른 기기와 저장이 겹치는' 상황을 만들어 봅니다.
 *
 * 확인하는 것:
 *   한 시간마다 뉴스가 뜨면 서른 명이 동시에 사고판다. 저장이 겹칠 수밖에 없는데,
 *   예전에는 그때 주문을 버리면서도 '샀어요!' 라고 알렸다. 학생 눈에는
 *   분명히 샀는데 주식이 없는 것처럼 보였다. 그 일이 다시 생기지 않아야 한다.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

/* ---------- 브라우저·서버 흉내 ---------- */
const stub = () => ({ addEventListener(){}, style:{}, classList:{add(){},remove(){},contains:()=>false},
    textContent:'', innerHTML:'', value:'', disabled:false, appendChild(){}, remove(){},
    querySelectorAll:()=>[], children:[] });
global.document = { getElementById: stub, createElement: stub, addEventListener(){}, body: stub(),
    querySelectorAll: () => [], visibilityState: 'visible' };
global.window = { addEventListener(){}, innerWidth: 400 };
global.location = { protocol: 'https:', hostname: 'x.pages.dev', reload(){} };
global.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
global.setInterval = () => 0; global.setTimeout = (fn) => { if (typeof fn === 'function') fn(); return 0; };

let alerts = [];
global.alert = m => alerts.push(String(m));
global.confirm = () => true;

let server = null;        // 서버에 들어 있다고 가정하는 내용
let beforeNextSave = null; // 다음 저장 직전에 딱 한 번 끼어드는 다른 기기

global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('/api/data')) throw new Error('저장소에 직접 접속하면 안 됩니다: ' + u);
    const method = opts.method || 'GET';
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });

    if (method === 'GET') {
        return ok({ record: JSON.parse(JSON.stringify(server)), rev: server.rev || 0 });
    }
    if (method === 'PUT') {
        // 저장 직전에 다른 기기가 먼저 저장하는 상황 (한 시간마다 뉴스가 뜰 때 실제로 벌어짐)
        if (beforeNextSave) { const f = beforeNextSave; beforeNextSave = null; f(); }
        const { baseRev, record } = JSON.parse(opts.body);
        const currentRev = server.rev || 0;
        if (currentRev !== baseRev) {
            return { ok: false, status: 409, json: async () => ({ error: 'conflict', rev: currentRev, record: server }) };
        }
        server = JSON.parse(JSON.stringify({ ...record, rev: currentRev + 1 }));
        return ok({ ok: true, rev: currentRev + 1 });
    }
    throw new Error('예상하지 못한 요청: ' + method);
};

const app = {};
eval(script + `
  app.buy = buyStock; app.sell = sellStock;
  app.setUser = id => { currentUser = id; };
  app.getDb = () => db;
  app.holdingOf = holdingOf;
  app.initStock = initStockMarket;
  app.COMPANIES = COMPANIES;
  app.BUILD = APP_BUILD;
  app.load = () => loadData({ silent: true });
`);

/* ---------- 도구 ---------- */
const CO = app.COMPANIES[0].id;

// 화면이 '수량' 칸에서 읽어가는 값을 정해 준다
function setOrderQty(n) {
    global.document.getElementById = (id) => {
        const el = stub();
        if (String(id).startsWith('qty-')) el.value = String(n);
        return el;
    };
}

function freshServer(price = 20, pi = 100) {
    const market = app.initStock(Date.now());
    Object.keys(market.companies).forEach(id => {
        market.companies[id].price = price;
        market.companies[id].anchor = price;
    });
    return {
        rev: 5,
        users: {
            admin: { name: '관리자', role: 'admin', password: '00', pi: 0, exp: 0, inventory: [], lottoTickets: [], stocks: {} },
            '7': { name: '7번 학생', role: 'student', password: '7', pi, exp: 0, inventory: [], lottoTickets: [], stocks: {} }
        },
        lotto: { currentPot: 0, rolloverPot: 0 },
        usageRequests: [], notice: '', bank: { loans: [], savings: [], logs: [] },
        stocks: market,
        lastSave: { at: new Date().toISOString(), by: '테스트', v: 'test', build: app.BUILD }
    };
}

// 학생이 주식 화면을 열어, 화면에 이미 자료가 떠 있는 상태로 만든다
async function openScreen() { await app.load(); }

const heldOnServer = () => app.holdingOf(server.users['7'], CO).qty;
const piOnServer = () => server.users['7'].pi;
const saidBought = () => alerts.some(m => /샀어요|팔았어요/.test(m));

const results = [];
const check = (name, cond) => results.push([name, !!cond]);

(async () => {
    /* ── 평소: 그냥 사진다 ── */
    server = freshServer();
    alerts = []; setOrderQty(2);
    app.setUser('7');
    await openScreen();
    await app.buy(CO);
    check('평범할 때 주식을 산다', heldOnServer() === 2);
    check('산 만큼 파이가 줄어든다', piOnServer() === 100 - 40);
    check('샀다고 알려준다', saidBought());

    /* ── 핵심: 저장 직전에 다른 기기가 먼저 저장한 경우 ──
       예전에는 여기서 주문이 버려지는데도 '샀어요!' 가 떴다 (주식이 사라지던 증상) */
    server = freshServer();
    alerts = []; setOrderQty(3);
    await openScreen();
    beforeNextSave = () => { server.rev += 1; server.notice = '다른 기기가 먼저 저장함'; };
    await app.buy(CO);
    check('겹쳐도 주식이 사라지지 않는다', heldOnServer() === 3);
    check('겹쳐도 파이가 맞다', piOnServer() === 100 - 60);
    check('다른 기기가 저장한 내용도 그대로 남는다', server.notice === '다른 기기가 먼저 저장함');
    check('겹쳤다고 학생을 놀라게 하지 않는다', !alerts.some(m => /덮어쓰지 않고|새로고침/.test(m)));
    check('그래도 샀다고 알려준다', saidBought());

    /* ── 파는 쪽도 같아야 한다 ── */
    server = freshServer();
    server.users['7'].stocks[CO] = [{ q: 4, cost: 80, at: Date.now(), paid: 0 }];
    alerts = []; setOrderQty(4);
    await openScreen();
    beforeNextSave = () => { server.rev += 1; };
    await app.sell(CO);
    check('겹쳐도 판 것이 제대로 반영된다', heldOnServer() === 0);
    check('판 만큼 파이를 받는다', piOnServer() === 100 + 80);

    /* ── 끝내 저장되지 않으면, 샀다고 거짓말하면 안 된다 ── */
    server = freshServer();
    alerts = []; setOrderQty(1);
    await openScreen();
    const bump = () => { server.rev += 1; beforeNextSave = bump; };   // 매번 끼어듦
    beforeNextSave = bump;
    await app.buy(CO);
    beforeNextSave = null;
    check('끝내 안 되면 주식도 파이도 그대로', heldOnServer() === 0 && piOnServer() === 100);
    check('끝내 안 되면 샀다고 하지 않는다', !saidBought());
    check('안 됐다고 분명히 알려준다', alerts.some(m => /처리되지 않았어요/.test(m)));

    /* ── 살 수 없는 상황은 예전처럼 그대로 막아야 한다 ── */
    server = freshServer(20, 10);        // 파이 10 으로 2주(40π)는 못 삼
    alerts = []; setOrderQty(2);
    await openScreen();
    await app.buy(CO);
    check('파이가 모자라면 사지 않는다', heldOnServer() === 0 && piOnServer() === 10);
    check('왜 안 되는지 알려준다', alerts.some(m => /파이가 부족/.test(m)));

    server = freshServer(5);             // 최저가에서는 살 수 없음
    alerts = []; setOrderQty(1);
    await openScreen();
    await app.buy(CO);
    check('최저가에서는 사지 않는다', heldOnServer() === 0);
    check('최저가라고 알려준다', alerts.some(m => /최저가/.test(m)));

    server = freshServer();
    alerts = []; setOrderQty(10);
    server.users['7'].pi = 10000;
    await openScreen();
    await app.buy(CO);
    const held = heldOnServer();
    alerts = []; setOrderQty(10);
    await app.buy(CO);                   // 한도(전체 10주)를 넘겨 또 사려 함
    check('보유 한도를 넘겨 사지 않는다', heldOnServer() === held);
    check('한도라고 알려준다', alerts.some(m => /주까지/.test(m)));

    server = freshServer();
    alerts = []; setOrderQty(1);
    await openScreen();
    await app.sell(CO);                  // 가진 게 없는데 팔려 함
    check('없는 주식은 팔지 않는다', piOnServer() === 100);
    check('없다고 알려준다', alerts.some(m => /부족/.test(m)));

    console.log('\n' + results.map(([n, ok]) => `  ${ok ? '통과' : '실패'}  ${n}`).join('\n'));
    const failed = results.filter(x => !x[1]).length;
    console.log(failed === 0 ? `\n전부 통과 (${results.length}개)\n` : `\n${failed}개 실패 / 전체 ${results.length}개\n`);
    process.exit(failed === 0 ? 0 : 1);
})();
