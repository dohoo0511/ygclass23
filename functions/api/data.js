// 학급 사이트의 데이터 읽기·쓰기를 서버에서 중계하는 Cloudflare Pages 함수
// 주소: /api/data   (functions 폴더 안의 파일 위치가 곧 주소)
//
// 필요한 환경 변수 (Cloudflare → Workers & Pages → 프로젝트 → 설정 → 변수 및 비밀)
//   JSONBIN_BIN_ID : 저장소 Bin ID
//   JSONBIN_KEY    : 저장소 Master Key  ← 화면(index.html)에는 더 이상 넣지 않음
//
// 이 함수가 있는 한, 저장은 반드시 "내가 읽은 판번호(baseRev)가 아직 최신일 때만" 이루어진다.
// 오래된 화면이 통째로 덮어쓰는 일이 구조적으로 불가능해진다.
// (예전 코드를 쓰는 기기는 열쇠를 모르므로 아예 저장하지 못한다)

const JSONBIN = "https://api.jsonbin.io/v3/b";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function revOf(record) {
  return record && typeof record.rev === "number" ? record.rev : 0;
}

// 학급 기록을 통째로 날리는 저장을 서버에서 막는 마지막 방어선
function looksValid(record) {
  return !!record
    && typeof record === "object"
    && !Array.isArray(record)
    && !!record.users
    && typeof record.users === "object"
    && Object.keys(record.users).length > 0;
}

async function binFetch(env, path, init = {}) {
  return fetch(`${JSONBIN}/${env.JSONBIN_BIN_ID}${path}`, {
    ...init,
    headers: { "X-Master-Key": env.JSONBIN_KEY, ...(init.headers || {}) },
  });
}

async function readLatest(env) {
  const res = await binFetch(env, "/latest");
  if (!res.ok) throw new Error(`저장소를 읽지 못했어요 (${res.status})`);
  const data = await res.json();
  const record = data && data.record;
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("저장소 데이터 형식이 올바르지 않아요");
  return record;
}

async function writeRecord(env, record) {
  const res = await binFetch(env, "", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
  if (!res.ok) throw new Error(`저장소에 쓰지 못했어요 (${res.status})`);
}

// 관리자 비밀번호 확인 (되돌리기처럼 위험한 작업에만 사용)
function isAdminPassword(current, password) {
  const admin = current && current.users && current.users.admin;
  return !!admin && typeof password === "string" && password.length > 0 && admin.password === password;
}

export async function onRequest({ request, env }) {
  if (!env || !env.JSONBIN_BIN_ID || !env.JSONBIN_KEY) {
    // 환경 변수가 아직 설정되지 않음 → 화면은 예전 방식(직접 접속)으로 내려감
    return json({ error: "JSONBIN_BIN_ID / JSONBIN_KEY 환경 변수가 설정되지 않았어요." }, 503);
  }
  const url = new URL(request.url);

  /* ---------- 읽기 ---------- */
  if (request.method === "GET") {
    try {
      // 복구 도구용: 예전 버전 목록
      if (url.searchParams.has("versions")) {
        const res = await binFetch(env, "/versions");
        if (!res.ok) throw new Error(`버전 목록을 읽지 못했어요 (${res.status})`);
        return json(await res.json());
      }
      // 복구 도구용: 특정 버전의 내용
      const version = url.searchParams.get("version");
      if (version !== null) {
        if (!/^\d{1,9}$/.test(version)) return json({ error: "버전 번호가 올바르지 않아요." }, 400);
        const res = await binFetch(env, `/${version}`);
        if (!res.ok) throw new Error(`해당 버전을 읽지 못했어요 (${res.status})`);
        return json(await res.json());
      }
      const record = await readLatest(env);
      return json({ record, rev: revOf(record) });
    } catch (error) {
      return json({ error: error.message }, 502);
    }
  }

  /* ---------- 저장 (판번호가 맞을 때만) ---------- */
  if (request.method === "PUT") {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "요청 형식이 올바르지 않아요." }, 400);
    }
    const baseRev = payload && payload.baseRev;
    const record = payload && payload.record;
    if (!Number.isInteger(baseRev) || baseRev < 0) return json({ error: "baseRev 가 필요해요." }, 400);
    if (!looksValid(record)) return json({ error: "학생 정보가 없는 데이터는 저장할 수 없어요." }, 400);

    let current;
    try {
      current = await readLatest(env);
    } catch (error) {
      return json({ error: error.message }, 502);
    }
    const currentRev = revOf(current);
    if (currentRev !== baseRev) {
      // 내가 읽은 뒤에 누군가 저장함 → 덮어쓰지 않고, 최신 내용을 돌려줌
      return json({ error: "conflict", rev: currentRev, record: current }, 409);
    }
    try {
      await writeRecord(env, { ...record, rev: currentRev + 1 });
    } catch (error) {
      return json({ error: error.message }, 502);
    }
    return json({ ok: true, rev: currentRev + 1 });
  }

  /* ---------- 되돌리기 (관리자 비밀번호 필요) ---------- */
  if (request.method === "POST") {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "요청 형식이 올바르지 않아요." }, 400);
    }
    const version = payload && payload.restoreVersion;
    if (!Number.isInteger(version) || version < 0) return json({ error: "되돌릴 버전 번호가 필요해요." }, 400);

    let current;
    try {
      current = await readLatest(env);
    } catch (error) {
      return json({ error: error.message }, 502);
    }
    if (!isAdminPassword(current, payload.password)) return json({ error: "관리자 비밀번호가 맞지 않아요." }, 403);

    let target;
    try {
      const res = await binFetch(env, `/${version}`);
      if (!res.ok) throw new Error(`해당 버전을 읽지 못했어요 (${res.status})`);
      target = (await res.json()).record;
    } catch (error) {
      return json({ error: error.message }, 502);
    }
    if (!looksValid(target)) return json({ error: "그 버전에는 학생 정보가 없어요. 다른 버전을 고르세요." }, 400);

    // 되돌린 뒤에도 판번호는 계속 커지도록 (되돌림 감지가 오작동하지 않게 함)
    const nextRev = Math.max(revOf(current), revOf(target)) + 1;
    try {
      await writeRecord(env, { ...target, rev: nextRev, restoredFrom: version, restoredAt: new Date().toISOString() });
    } catch (error) {
      return json({ error: error.message }, 502);
    }
    return json({ ok: true, rev: nextRev, restoredFrom: version });
  }

  return json({ error: "GET, PUT, POST 만 받을 수 있어요." }, 405);
}
