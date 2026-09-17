/*
 * 서버 함수(/api/data) 테스트
 *
 * 실행:  node test/data-api.test.js
 *
 * functions/api/data.js 를 그대로 불러와, 저장소와 네트워크를 흉내 낸 환경에서 돌립니다.
 * 진짜 저장소에는 접속하지 않습니다.
 *
 * 확인하는 것: 오래된 화면의 저장을 서버가 확실히 막는가, 위험한 저장을 거부하는가,
 * 점검 주소가 학생 정보를 흘리지 않는가
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'functions', 'api', 'data.js');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ygfn-')), 'data.mjs');
fs.copyFileSync(SRC, tmp);

const ENV = { JSONBIN_BIN_ID: 'bin123', JSONBIN_KEY: 'secret-key' };

let storage = null;      // 저장소에 들어 있다고 가정하는 내용
var versionStore = {};   // 버전 번호 -> 내용
let storageUp = true;
let versionsStatus = 200;   // 저장소가 버전 목록에 주는 응답
let sentKeys = [];       // 저장소로 나간 요청의 열쇠 (서버만 알고 있어야 함)

global.fetch = async (url, opts = {}) => {
    sentKeys.push(opts.headers && opts.headers['X-Master-Key']);
    if (!storageUp) return { ok: false, status: 500, json: async () => ({}) };
    const u = String(url);
    const method = opts.method || 'GET';
    if (method === 'GET' && u.endsWith('/latest')) {
        return { ok: true, status: 200, json: async () => ({ record: JSON.parse(JSON.stringify(storage)) }) };
    }
    if (method === 'GET' && u.endsWith('/versions')) {
        if (versionsStatus !== 200) return { ok: false, status: versionsStatus, json: async () => ({}) };
        const list = Object.keys(versionStore).map((v, i) => ({ id: Number(v), createdAt: `2026-09-1${i + 5}T00:00:00Z` }));
        return { ok: true, status: 200, json: async () => ({ record: { versions: list } }) };
    }
    if (method === 'GET') {
        const v = u.split('/').pop();
        if (!(v in versionStore)) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ record: JSON.parse(JSON.stringify(versionStore[v])) }) };
    }
    if (method === 'PUT') { storage = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: false, status: 405, json: async () => ({}) };
};

const req = (method, query = '', body = null) => new Request(`https://example.pages.dev/api/data${query}`, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {})
});

const results = [];
const check = (name, cond) => results.push([name, !!cond]);

(async () => {
    const { onRequest } = await import('file://' + tmp);
    const call = async (method, query, body, env = ENV) => {
        const res = await onRequest({ request: req(method, query, body), env });
        return { status: res.status, body: await res.json() };
    };

    /* ── 환경 변수가 없을 때: 왜 안 보이는지 짚어 줘야 함 ── */
    let r = await call('GET', '?check=1', null, {});
    check('환경 변수 없으면 503', r.status === 503);
    check('무엇이 빠졌는지 알려줌', Array.isArray(r.body.missing) && r.body.missing.length === 2);
    check('하나도 없으면 그렇게 안내', /하나도 없어요/.test(r.body.hint));

    // 이름을 잘못 적은 경우 → 그 이름을 그대로 보여줘야 함
    r = await call('GET', '?check=1', null, { JSONBIN_BIN_ID: 'bin123', JSONBIN_API_KEY: 'x' });
    check('철자 틀린 이름을 찾아냄', r.body.similarNames.includes('JSONBIN_API_KEY'));
    check('철자 확인을 안내', /철자/.test(r.body.hint));
    check('빠진 것은 KEY 하나로 보고', r.body.missing.length === 1 && r.body.missing[0] === 'JSONBIN_KEY');

    // 이름은 맞는데 값이 비어 있는 경우
    r = await call('GET', '?check=1', null, { JSONBIN_BIN_ID: 'bin123', JSONBIN_KEY: '' });
    check('값이 비었음을 구분해서 알려줌', r.body.emptyValue.includes('JSONBIN_KEY') && /값이 비어/.test(r.body.hint));

    // 값도 이름도 정상인데 KEY 만 아예 없는 경우 → 재배포 안내
    r = await call('GET', '?check=1', null, { JSONBIN_BIN_ID: 'bin123', GEMINI_API_KEY: 'g' });
    check('그 밖에는 재배포를 안내', /재배포/.test(r.body.hint));
    check('관계없는 비밀 이름은 보여주지 않음', !r.body.similarNames.includes('GEMINI_API_KEY'));
    check('환경 변수 값은 어떤 경우에도 돌려주지 않음', !JSON.stringify(r.body).includes('bin123'));

    /* ── 점검 주소 ── */
    storage = { rev: 10, users: { admin: { password: '비밀번호', name: '관리자' }, '1': { pi: 5, password: '1' } }, lastSave: { by: '관리자' } };
    r = await call('GET', '?check=1');
    check('점검 주소 정상 응답', r.status === 200 && r.body.ok === true);
    check('점검 주소가 판번호·인원을 알려줌', r.body.rev === 10 && r.body.users === 2);
    check('점검 주소가 학생 정보를 흘리지 않음', !JSON.stringify(r.body).includes('비밀번호'));

    /* ── 예전 버전이 남아 있는지 알려주기 (되살릴 수 있는지 판단) ── */
    versionStore[3] = { rev: 3, users: { admin: {} } };
    versionStore[4] = { rev: 4, users: { admin: {} } };
    r = await call('GET', '?check=1');
    check('버전이 있으면 개수를 알려줌', r.body.versions.available === true && r.body.versions.count === 2);
    check('가장 오래된/최근 시각을 알려줌', !!r.body.versions.oldest && !!r.body.versions.newest);
    check('되살릴 수 있다고 안내', /restore\.html/.test(r.body.versions.hint));

    versionsStatus = 403;   // 요금제에서 지원하지 않거나 꺼져 있는 경우
    r = await call('GET', '?check=1');
    check('버전을 쓸 수 없으면 그렇게 알려줌', r.body.versions.available === false && r.body.versions.reason === 'HTTP 403');
    check('대신 쓸 방법을 안내', /빨간 띠/.test(r.body.versions.hint));
    check('버전을 못 읽어도 연결 자체는 정상으로 봄', r.body.ok === true);
    versionsStatus = 200;

    const savedVersions = { ...versionStore };
    versionStore = {};
    r = await call('GET', '?check=1');
    check('보관된 버전이 하나도 없으면 그렇게 알려줌', r.body.versions.available === false && /없어요/.test(r.body.versions.reason));
    versionStore = savedVersions;

    /* ── 읽기 ── */
    r = await call('GET', '');
    check('읽기 성공', r.status === 200 && r.body.rev === 10 && !!r.body.record.users);

    /* ── 저장: 판번호가 맞을 때만 ── */
    const good = { users: { admin: {}, '1': { pi: 6 } }, note: '새 내용' };
    r = await call('PUT', '', { baseRev: 10, record: good });
    check('판번호가 맞으면 저장됨', r.status === 200 && r.body.rev === 11);
    check('저장소에 반영되고 판번호가 올라감', storage.rev === 11 && storage.note === '새 내용');

    const before = JSON.stringify(storage);
    r = await call('PUT', '', { baseRev: 10, record: { users: { admin: {} }, note: '오래된 화면' } });
    check('오래된 판번호로 저장하면 409', r.status === 409);
    check('409 일 때 저장소가 바뀌지 않음', JSON.stringify(storage) === before);
    check('409 가 최신 내용을 함께 돌려줌', r.body.rev === 11 && !!r.body.record);

    r = await call('PUT', '', { baseRev: 11, record: { note: '학생 정보 없음' } });
    check('학생 정보 없는 저장은 400 으로 거부', r.status === 400);
    check('거부 후 저장소 그대로', JSON.stringify(storage) === before);

    r = await call('PUT', '', { record: good });
    check('baseRev 없으면 400', r.status === 400);

    /* ── 되돌리기: 관리자 비밀번호 필요 ── */
    storage = { rev: 50, users: { admin: { password: 'pw!' }, '1': { pi: 1 } } };
    versionStore[7] = { rev: 20, users: { admin: { password: 'pw!' }, '1': { pi: 99 } }, note: '되살릴 내용' };

    r = await call('POST', '', { restoreVersion: 7, password: '틀린비번' });
    check('비밀번호 틀리면 403', r.status === 403);
    check('403 이면 저장소 그대로', storage.rev === 50);

    r = await call('POST', '', { restoreVersion: 7, password: 'pw!' });
    check('비밀번호 맞으면 되돌아감', r.status === 200 && storage.users['1'].pi === 99);
    check('판번호는 이전 최고값 위로 올라감', storage.rev === 51);
    check('어느 버전에서 되살렸는지 남음', storage.restoredFrom === 7);

    versionStore[8] = { rev: 21, note: '학생 정보 없는 버전' };
    const keep = JSON.stringify(storage);
    r = await call('POST', '', { restoreVersion: 8, password: 'pw!' });
    check('학생 정보 없는 버전으로는 되돌리지 않음', r.status === 400 && JSON.stringify(storage) === keep);

    /* ── 그 밖 ── */
    r = await call('DELETE', '');
    check('허용하지 않는 방식은 405', r.status === 405);

    storageUp = false;
    r = await call('GET', '?check=1');
    check('저장소 연결 실패는 502 로 알려줌', r.status === 502 && r.body.ok === false);
    storageUp = true;

    check('열쇠는 서버에서만 쓰임', sentKeys.length > 0 && sentKeys.every(k => k === ENV.JSONBIN_KEY));

    console.log('\n' + results.map(([n, ok]) => `  ${ok ? '통과' : '실패'}  ${n}`).join('\n'));
    const failed = results.filter(x => !x[1]).length;
    console.log(failed === 0 ? `\n전부 통과 (${results.length}개)\n` : `\n${failed}개 실패 / 전체 ${results.length}개\n`);
    process.exit(failed === 0 ? 0 : 1);
})();
