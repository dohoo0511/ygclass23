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

// 어떤 환경 변수가 왜 안 보이는지 알려줌.
// 값은 절대 돌려주지 않고, 이름만 (그것도 저장소와 관련 있어 보이는 것만) 보여준다
const REQUIRED = ["JSONBIN_BIN_ID", "JSONBIN_KEY"];

function envDiagnosis(env) {
  const vars = env || {};
  const names = Object.keys(vars);
  const missing = REQUIRED.filter((name) => !vars[name]);
  // 이름은 있는데 값이 비어 있는 경우 (붙여넣기가 안 된 경우)
  const emptyValue = missing.filter((name) => name in vars);
  // 철자가 틀렸는지 알 수 있도록, 저장소와 관련 있어 보이는 이름만 보여줌
  const similarNames = names.filter((name) => /json|bin/i.test(name));
  const unexpected = similarNames.filter((name) => !REQUIRED.includes(name));

  let hint;
  if (emptyValue.length > 0) {
    hint = `${emptyValue.join(", ")} 은(는) 이름만 있고 값이 비어 있어요. 값을 다시 붙여넣고 재배포해주세요.`;
  } else if (unexpected.length > 0) {
    hint = `비슷한 이름이 있어요: ${unexpected.join(", ")}. 철자가 ${REQUIRED.join(", ")} 와 정확히 같은지 확인해주세요.`;
  } else if (names.length === 0) {
    hint = "이 배포에는 환경 변수가 하나도 없어요. 프로덕션(미리 보기 아님)에 등록하고 재배포해주세요.";
  } else {
    hint = `${missing.join(", ")} 을(를) 프로덕션 환경 변수로 등록한 뒤, 배포 탭에서 재배포(Retry deployment)해주세요.`;
  }

  return {
    missing,
    emptyValue,
    similarNames,
    varCount: names.length,
    hint,
    error: `${missing.join(", ")} 환경 변수가 설정되지 않았어요.`,
  };
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const isCheck = url.searchParams.has("check");

  if (!env || !env.JSONBIN_BIN_ID || !env.JSONBIN_KEY) {
    return json({ ok: false, step: "환경 변수", ...envDiagnosis(env) }, 503);
  }

  // 설정이 제대로 됐는지 확인하는 용도. 학생 정보는 하나도 돌려주지 않는다
  // 사용법: 사이트주소/api/data?check=1
  if (isCheck) {
    try {
      const record = await readLatest(env);
      return json({
        ok: true,
        step: "완료",
        message: "서버 함수가 저장소에 정상 연결되었습니다.",
        rev: revOf(record),
        users: Object.keys(record.users || {}).length,
        lastSave: record.lastSave || null,
        restoredFrom: typeof record.restoredFrom === "number" ? record.restoredFrom : null,
      });
    } catch (error) {
      return json({
        ok: false,
        step: "저장소 연결",
        error: `${error.message} — 새 Master Key 와 Bin ID 가 맞는지 확인해주세요.`,
      }, 502);
    }
  }

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
