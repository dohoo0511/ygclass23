// 아주 작은 화면 만들기 도구
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value" || k === "disabled" || k === "checked") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : String(kid));
  }
  return el;
}

// 남은 시간 표시: 화면이 0.2초마다 숫자를 고쳐 준다
export function countdown(remainMs, receivedAt, cls = "cd") {
  if (!remainMs) return null;
  const until = receivedAt + remainMs;
  return h("span", { class: cls, "data-until": until }, `${Math.ceil(remainMs / 1000)}초`);
}

export function tickCountdowns() {
  const now = Date.now();
  for (const el of document.querySelectorAll("[data-until]")) {
    const left = Math.max(0, Number(el.dataset.until) - now);
    el.textContent = `${Math.ceil(left / 1000)}초`;
    el.classList.toggle("urgent", left < 5000);
  }
}
