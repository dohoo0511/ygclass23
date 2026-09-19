/*
 * AI 기사 함수(/api/stock-news) 테스트
 *
 * 실행:  node test/stock-news.test.js
 *
 * functions/api/stock-news.js 를 그대로 불러와, Gemini 를 흉내 낸 환경에서 돌립니다.
 * 진짜 Gemini 에는 접속하지 않습니다.
 *
 * 확인하는 것: 화면이 보내는 모든 사건 종류를 받아 주는가,
 * 한 건이 이상해도 나머지 기사를 살리는가
 * (조용한 하루 기사가 섞이면 묶음 전체가 실패해서 기사가 하나도 안 바뀌던 일이 있었다)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'functions', 'api', 'stock-news.js');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ygnews-')), 'news.mjs');
fs.copyFileSync(SRC, tmp);

let geminiCalls = [];
let geminiFails = null;      // { status, body } 로 두면 그 응답을 돌려줌

global.fetch = async (url, opts = {}) => {
    const body = JSON.parse(opts.body);
    geminiCalls.push(body);
    if (geminiFails) {
        return { ok: false, status: geminiFails.status, json: async () => geminiFails.body, text: async () => '' };
    }
    // 요청에 들어 있는 id 를 뽑아서 그 개수만큼 기사를 써 준다
    const prompt = body.contents[0].parts[0].text;
    const ids = [...prompt.matchAll(/\[id: (n\d+)\]/g)].map(m => m[1]);
    return {
        ok: true, status: 200,
        json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify({
                articles: ids.map(id => ({ id, title: `제목 ${id}`, body: `본문 ${id} 입니다.` }))
            }) }] } }]
        }),
        text: async () => ''
    };
};

const ENV = { GEMINI_API_KEY: 'test-key' };
const req = (body, method = 'POST') => new Request('https://example.pages.dev/api/stock-news', {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {})
});

const results = [];
const check = (name, cond) => results.push([name, !!cond]);
// 기사가 아예 안 오면 undefined 라서 검사 도중 터진다. 그때도 '실패' 로 남도록 감싼다
const arts = r => (r && r.body && Array.isArray(r.body.articles)) ? r.body.articles : [];

// 화면이 실제로 보내는 모양
const single = (id, sentiment = 'good') => ({
    id, kind: 'single', companyId: 'taehoon', partnerId: null,
    sentiment, level: 'small', deltas: { taehoon: sentiment === 'good' ? 1 : -1 }, title: '태훈전자 소식'
});
const quiet = (id) => ({
    id, kind: 'quiet', companyId: 'dohoo', partnerId: null,
    sentiment: 'flat', level: 'none', deltas: {}, title: '도후식품, 판매량이 지난주와 비슷했다'
});
const contract = (id) => ({
    id, kind: 'contract_sign', companyId: 'taehoon', partnerId: 'ttaek',
    sentiment: 'good', level: 'medium', deltas: { taehoon: 2, ttaek: 1 }, title: '두 회사 계약'
});

(async () => {
    const { onRequest } = await import('file://' + tmp);
    const call = async (body, env = ENV, method = 'POST') => {
        const res = await onRequest({ request: req(body, method), env });
        return { status: res.status, body: await res.json() };
    };

    /* ── 평범한 사건들 ── */
    let r = await call({ items: [single('n1'), contract('n2')] });
    check('보통 사건은 기사가 나옴', r.status === 200 && arts(r).length === 2);

    /* ── 핵심: 조용한 하루 기사 ──
       예전에는 이것이 섞이면 묶음 전체가 400 이 됐다 */
    r = await call({ items: [quiet('n3')] });
    check("'조용한 하루' 사건도 기사가 나옴", r.status === 200 && arts(r).length === 1);

    r = await call({ items: [single('n4'), quiet('n5'), contract('n6'), quiet('n7')] });
    check('조용한 하루가 섞여도 묶음 전체가 살아남음', r.status === 200 && arts(r).length === 4);
    check('섞인 묶음에서 조용한 기사도 빠지지 않음',
        arts(r).some(a => a.id === 'n5') && arts(r).some(a => a.id === 'n7'));

    /* ── 한 건이 이상해도 나머지는 살려야 함 ── */
    geminiCalls = [];
    r = await call({ items: [single('n8'), { id: 'n9', kind: '엉터리' }, single('n10')] });
    check('이상한 건이 섞여도 나머지 기사는 나옴', r.status === 200 && arts(r).length === 2);
    check('이상한 건은 Gemini 에 보내지도 않음',
        geminiCalls.length > 0 && !JSON.stringify(geminiCalls).includes('n9'));

    r = await call({ items: [{ id: 'nope' }, { kind: 'single' }] });
    check('전부 이상하면 400', r.status === 400);

    /* ── 보내면 안 되는 값은 계속 막아야 함 ── */
    r = await call({ items: [{ ...single('n11'), sentiment: '아무거나' }] });
    check('모르는 방향(sentiment)은 거부', r.status === 400);
    r = await call({ items: [{ ...contract('n12'), partnerId: null }] });
    check('계약 사건인데 상대 회사가 없으면 거부', r.status === 400);
    r = await call({ items: [{ ...single('n13'), companyId: '없는회사' }] });
    check('모르는 회사는 거부', r.status === 400);
    r = await call({ items: [{ ...single('n14'), id: '<script>' }] });
    check('이상한 id 는 거부', r.status === 400);

    /* ── 그 밖 ── */
    r = await call({ items: [] });
    check('빈 목록은 400', r.status === 400);
    r = await call({ items: new Array(20).fill(0).map((_, i) => single('n' + (100 + i))) });
    check('너무 많이 보내면 400', r.status === 400);
    r = await call({ items: [single('n15')] }, {});
    check('API 키가 없으면 500', r.status === 500);
    r = await call(null, ENV, 'GET');
    check('GET 은 405', r.status === 405);

    geminiFails = { status: 429, body: { error: { message: 'quota' } } };
    r = await call({ items: [single('n16')] });
    check('Gemini 가 실패하면 그대로 알려줌', r.status >= 400 && typeof r.body.error === 'string');
    geminiFails = null;

    console.log('\n' + results.map(([n, ok]) => `  ${ok ? '통과' : '실패'}  ${n}`).join('\n'));
    const failed = results.filter(x => !x[1]).length;
    console.log(failed === 0 ? `\n전부 통과 (${results.length}개)\n` : `\n${failed}개 실패 / 전체 ${results.length}개\n`);
    process.exit(failed === 0 ? 0 : 1);
})();
