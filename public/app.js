const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const MAX_LEN = 1000;
const COUNTER_FROM = 800;
const STORE_KEY = "pine.conversation";
const GREETING = "Hi, I'm Pine from Larkspur & Pine. How can I help today?";
const NETWORK_MSG = "Couldn't reach Pine. Your message wasn't sent.";

let meta = null;
let conv = null;
let gen = 0; // bumps on every conversation switch; stale async work compares against it
let pending = null; // { gen, ctrl } for the in-flight customer message
const deciding = new Set(); // refund ids with an Approve/Deny request in flight
let traceStick = true; // auto-scroll the trace only while the user is near the bottom
let traceTarget = null; // trace index to scroll to once the Trace tab is visible

// --- helpers -----------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new ApiError(NETWORK_MSG, 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(typeof body.error === "string" ? body.error : "Something went wrong.", res.status);
  return body;
}

/** A customer-safe message for a failed request: never a raw status code. */
function friendly(e, fallback = NETWORK_MSG) {
  if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) return fallback;
  return e.message.replace(/\s*\((?:HTTP\s*)?\d{3}\)|\s*HTTP\s*\d{3}/g, "");
}

const store = {
  get() { try { return sessionStorage.getItem(STORE_KEY); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem(STORE_KEY, v) : sessionStorage.removeItem(STORE_KEY); } catch { /* storage unavailable */ } },
};

/** Append text to `parent`, turning https:// URLs into links. DOM APIs only, never innerHTML. */
function appendLinkified(parent, text) {
  const re = /https:\/\/[^\s<>"'`]+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    let url = m[0];
    const trail = url.match(/[.,;:!?)\]}'"]+$/);
    if (trail) url = url.slice(0, -trail[0].length);
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = url;
    parent.appendChild(a);
    last = m.index + url.length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function scrollMessages() { const m = $("#messages"); m.scrollTop = m.scrollHeight; }

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (role === "agent") appendLinkified(div, String(text ?? ""));
  else div.textContent = String(text ?? "");
  $("#messages").appendChild(div);
  scrollMessages();
  return div;
}

/** A system line in the chat, optionally with one action button (e.g. Retry). */
function addSystem(text, action) {
  const div = addMsg("system", text);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link-btn";
    btn.textContent = action.label;
    btn.onclick = () => { div.remove(); action.run(); };
    div.append(" ", btn);
  }
  scrollMessages();
  return div;
}

function setBusy(on) {
  $("#send").disabled = on;
  $("#messages").setAttribute("aria-busy", on ? "true" : "false");
}

function abortPending() {
  if (pending) { pending.ctrl.abort(); pending = null; }
  setBusy(false);
  $("#messages .typing")?.remove();
}

// --- conversation lifecycle ------------------------------------------------------

function resetView() {
  conv = null;
  deciding.clear();
  traceStick = true;
  traceTarget = null;
  $("#messages").replaceChildren();
  hideOpsNotice();
  render();
}

async function newConversation(notice) {
  abortPending();
  const my = ++gen;
  resetView();
  store.set(null);
  try {
    const c = await api("/api/conversations", { method: "POST" });
    if (my !== gen) return false;
    conv = c;
    store.set(conv.id);
    addMsg("agent", GREETING);
    if (notice) addSystem(notice);
    render();
    return true;
  } catch (e) {
    if (my !== gen) return false;
    addSystem(friendly(e, "Couldn't reach Pine to start a conversation."), { label: "Try again", run: () => newConversation(notice) });
    return false;
  }
}

/** Restore the conversation saved in this tab, or start a new one. */
async function restoreOrStart() {
  const id = store.get();
  if (!id) return newConversation();
  const my = ++gen;
  try {
    const c = await api(`/api/conversations/${encodeURIComponent(id)}`);
    if (my !== gen) return;
    conv = c;
    $("#messages").replaceChildren();
    addMsg("agent", GREETING);
    for (const e of conv.trace ?? []) {
      if (e.type === "customer_message") addMsg("customer", e.text);
      else if (e.type === "agent_message") addMsg("agent", e.text);
    }
    if (conv.status === "handoff") addSystem("Conversation handed off to a human specialist");
    render();
  } catch (e) {
    if (my !== gen) return;
    if (e instanceof ApiError && e.status === 404) return newConversation();
    addSystem(friendly(e, "Couldn't reach Pine to load your conversation."), { label: "Try again", run: restoreOrStart });
  }
}

function noteHandoff(prevStatus) {
  if (conv?.status === "handoff" && prevStatus !== "handoff") addSystem("Conversation handed off to a human specialist");
}

async function send(text) {
  if (pending || !text.trim()) return;
  if (text.length > MAX_LEN) { updateCounter(true); return; }
  const input = $("#input");
  if (!conv) {
    // Conversation creation failed earlier: try again before sending.
    if (!(await newConversation())) return;
  }
  const my = gen;
  const ctrl = new AbortController();
  pending = { gen: my, ctrl };
  setBusy(true);
  if (input.value === text) { input.value = ""; autosize(); updateCounter(); }
  const bubble = addMsg("customer", text);
  const typing = addMsg("agent typing", "Pine is working…");
  typing.setAttribute("aria-hidden", "true");
  try {
    const res = await api(`/api/conversations/${encodeURIComponent(conv.id)}/messages`, { method: "POST", body: JSON.stringify({ text }), signal: ctrl.signal });
    if (my !== gen || res.id !== conv?.id) return; // stale: conversation was replaced
    typing.remove();
    addMsg("agent", res.reply);
    const prev = conv.status;
    conv = res;
    noteHandoff(prev);
    render();
  } catch (e) {
    if (e?.name === "AbortError" || my !== gen) return;
    typing.remove();
    const restore = () => { if (!input.value.trim()) { input.value = text; autosize(); updateCounter(); } };
    if (e instanceof ApiError && e.status === 404) {
      pending = null;
      setBusy(false);
      await newConversation("Your previous conversation expired, so I started a new one. Your message is still in the box; press Send to try again.");
      restore();
      input.focus();
      return;
    }
    bubble.classList.add("failed");
    restore();
    addSystem(friendly(e), {
      label: "Retry",
      run: () => {
        if (input.value === text) { input.value = ""; autosize(); updateCounter(); }
        bubble.remove();
        send(text);
      },
    });
  } finally {
    if (my === gen && pending?.ctrl === ctrl) {
      pending = null;
      setBusy(false);
      typing.remove();
      input.focus();
    }
  }
}

// --- ops actions -------------------------------------------------------------

function showOpsNotice(text, kind = "info") {
  const n = $("#ops-notice");
  n.textContent = text;
  n.className = `ops-notice ${kind}`;
}
function hideOpsNotice() {
  const n = $("#ops-notice");
  n.textContent = "";
  n.className = "ops-notice hidden";
}

async function decide(refundId, decision) {
  if (!conv || deciding.has(refundId)) return;
  const my = gen;
  deciding.add(refundId);
  renderBackend();
  try {
    const res = await api(`/api/conversations/${encodeURIComponent(conv.id)}/refunds/${encodeURIComponent(refundId)}`, { method: "POST", body: JSON.stringify({ decision }) });
    if (my !== gen || res.id !== conv?.id) return;
    const prev = conv.status;
    conv = res;
    deciding.delete(refundId);
    if (res.note) addMsg("agent", res.note);
    noteHandoff(prev);
    const idx = (conv.trace ?? []).findLastIndex((e) => e.type === "approval");
    if (idx >= 0) traceTarget = idx;
    showOpsNotice(`Refund ${refundId} ${decision === "approve" ? "approved" : "denied"}. The customer was notified.`, "ok");
    render();
    $("#tab-backend").focus();
  } catch (e) {
    if (my !== gen) return;
    deciding.delete(refundId);
    showOpsNotice(`Couldn't ${decision} refund ${refundId}: ${e instanceof ApiError && e.status ? e.message : "the server could not be reached."}`, "bad");
    renderBackend();
    $("#tab-backend").focus();
  }
}

// --- ops rendering -----------------------------------------------------------

function render() {
  renderState();
  renderTrace();
  renderBackend();
}

function renderState() {
  if (!conv) { $("#state").innerHTML = `<div class="row"><span class="muted">No conversation yet</span></div>`; return; }
  const c = conv;
  const u = c.usage ?? {};
  const n = (v) => Number(v ?? 0);
  const pills = [];
  pills.push(c.status === "handoff" ? `<span class="pill warn">● handed off</span>` : `<span class="pill ok">● agent active</span>`);
  pills.push(c.verified_customer ? `<span class="pill ok">verified: ${esc(c.verified_customer.name)}</span>` : `<span class="pill">not verified</span>`);
  pills.push(`<span class="pill">${n(u.model_calls)} model calls</span>`);
  pills.push(`<span class="pill">${(n(u.input_tokens) + n(u.cache_read) + n(u.cache_write)).toLocaleString()} in / ${n(u.output_tokens).toLocaleString()} out tok</span>`);
  pills.push(`<span class="pill">$${n(u.cost_usd).toFixed(4)}</span>`);
  let steps = `<span class="muted">No procedure loaded yet</span>`;
  const aop = meta?.aops?.find((a) => a.id === c.active_aop);
  if (aop) {
    steps = `<span class="pill">${esc(aop.id)} v${esc(aop.version)}</span>` + aop.steps.map((s) => {
      const cls = s.n === c.current_step ? "current" : c.current_step && s.n < c.current_step ? "done" : "";
      return `<span class="s ${cls}" title="${esc(s.text)}">${s.n}. ${esc(s.title)}</span>`;
    }).join("");
  }
  $("#state").innerHTML = `<div class="row">${pills.join("")}</div><div class="row steps">${steps}</div>`;
}

function evLabel(e) {
  switch (e.type) {
    case "customer_message": return ["Customer", e.text];
    case "agent_message": return ["Agent reply", e.text];
    case "agent_note": return ["Agent working note (not shown to customer)", e.text];
    case "model_call": return [`Model call · ${e.stop_reason}`, `${e.model} · ${e.latency_ms} ms · in ${e.input_tokens} + cache ${e.cache_read} read / ${e.cache_write} write · out ${e.output_tokens}`];
    case "procedure_loaded": return [`Loaded AOP ${e.aop_id} v${e.version}`, ""];
    case "step": return [`AOP step ${e.step}: ${e.title}`, ""];
    case "tool_call": return [`Tool call → ${e.name}`, JSON.stringify(e.input, null, 1)];
    case "tool_result": return [`Tool result ← ${e.name}${e.ok ? "" : " (error)"}`, JSON.stringify(e.output, null, 1)];
    case "guardrail": return [`Guardrail ${String(e.decision).toUpperCase()} · ${e.rule}${e.tool ? ` (${e.tool})` : ""}`, e.detail];
    case "handoff": return [`Handoff → ticket ${e.ticket_id} (${e.reason})`, e.summary];
    case "approval": return [`Human ${e.decision} refund ${e.refund_id}`, `by ${e.by}`];
    default: return [e.type, JSON.stringify(e)];
  }
}

const TRACE_EMPTY = `<li class="muted empty">Send a message to see the agent's trace: procedure, steps, tool calls, and guardrail decisions.
  <p class="tip">Tip: Opus usually refuses attacks from the prompt alone; the code guardrails are the backstop (see the prompt-only ablation in the README). Splitting a large refund, or saying 'cancel it, I'm sure' on LP-1003, shows a code-level block.</p></li>`;

function renderTrace() {
  const trace = conv?.trace ?? [];
  const t0 = trace[0]?.t ?? 0;
  let lastTurn = 0;
  const html = [];
  trace.forEach((e, i) => {
    if (e.turn !== lastTurn) { html.push(`<li class="turn-sep">Turn ${esc(e.turn)}</li>`); lastTurn = e.turn; }
    const [k, body] = evLabel(e);
    const cls = `${esc(e.type)} ${esc(e.decision ?? "")}`;
    html.push(`<li class="ev ${cls}" data-i="${i}"><div class="h"><span class="k">${esc(k)}</span><span class="t">+${((e.t - t0) / 1000).toFixed(1)}s</span></div>${body ? `<pre>${esc(body)}</pre>` : ""}</li>`);
  });
  $("#trace").innerHTML = html.join("") || TRACE_EMPTY;
  positionTrace();
}

/** Scroll the trace: to a pending target (e.g. a new approval), else to the bottom if the user was there. */
function positionTrace() {
  const box = $("#tab-trace");
  if (box.classList.contains("hidden")) return; // apply when the tab is shown
  if (traceTarget !== null) {
    const el = box.querySelector(`[data-i="${traceTarget}"]`);
    traceTarget = null;
    if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("flash"); return; }
  }
  if (traceStick) box.scrollTop = box.scrollHeight;
}

const isSeed = (r) => r.decided_by === "seed" || /-0$/.test(String(r.id ?? ""));
const money = (v) => `$${Number(v ?? 0).toFixed(2)}`;
const table = (head, rows, cols) => `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${cols}" class="muted">none</td></tr>`}</tbody></table></div>`;

function fmtAddress(a) {
  if (!a) return "";
  if (typeof a === "string") return a;
  return [a.name, a.line1, a.line2, a.city, a.state ?? a.region, a.zip ?? a.postal_code, a.country].filter(Boolean).join(", ") || JSON.stringify(a);
}

function renderBackend() {
  const box = $("#tab-backend");
  if (!conv) { box.innerHTML = `<p class="muted">No conversation yet.</p>`; return; }
  const b = conv.backend ?? {};
  const refundsList = b.refunds ?? [];
  const refunds = refundsList.map((r) => {
    const seed = isSeed(r);
    const busy = deciding.has(r.id);
    const actions = r.status === "pending_approval" && meta?.ops_approval
      ? `<div class="actions"><button type="button" class="approve" data-refund="${esc(r.id)}" data-d="approve" aria-label="Approve refund ${esc(r.id)}"${busy ? " disabled" : ""}>Approve</button><button type="button" class="deny" data-refund="${esc(r.id)}" data-d="deny" aria-label="Deny refund ${esc(r.id)}"${busy ? " disabled" : ""}>Deny</button></div>`
      : "";
    return `<tr class="${seed ? "seed" : ""}"><td>${money(r.amount)}</td><td>${esc(r.status)}${actions}</td><td>${esc(r.order_id)}</td><td>${esc(r.reason)}</td><td>${esc(r.id)}</td><td>${seed ? "pre-existing (seed data)" : esc(r.decided_by ?? "")}</td></tr>`;
  }).join("");
  const orders = (b.orders ?? []).map((o) => `<tr><td>${esc(o.order_id ?? o.id)}</td><td>${esc(o.status)}</td><td class="long">${esc(fmtAddress(o.shipping_address))}</td></tr>`).join("");
  const returns = (b.returns ?? []).map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.order_id)}</td><td>${esc(r.sku)}</td><td>${esc(r.reason)}</td></tr>`).join("");
  const tickets = (b.tickets ?? []).map((t) => `<tr><td>${esc(t.id)}</td><td>${esc(t.reason)}</td><td>${esc(t.priority)}</td><td class="long">${esc(t.summary)}</td></tr>`).join("");
  box.innerHTML = `
    <p class="muted">Each conversation runs against its own freshly seeded copy of the store backend.</p>
    <h3>Refunds</h3>${refundsList.some((r) => r.status === "pending_approval") ? `<p class="muted">Simulated ops: approve or deny as the human specialist would.</p>` : ""}
    ${table(["Amount", "Status", "Order", "Reason", "ID", "Decided by"], refunds, 6)}
    <h3>Order changes</h3>${table(["Order", "Status", "Shipping address"], orders, 3)}
    <h3>Returns</h3>${table(["ID", "Order", "SKU", "Reason"], returns, 4)}
    <h3>Handoff tickets</h3>${table(["ID", "Reason", "Priority", "Summary"], tickets, 4)}`;
  for (const btn of box.querySelectorAll("[data-refund]")) btn.onclick = () => decide(btn.dataset.refund, btn.dataset.d);
}

function renderAops() {
  $("#tab-aops").innerHTML = `<p class="muted">Procedures are written in plain markdown and compiled into validated steps. The agent loads one with <code>load_procedure</code>; action tools outside the loaded procedure are blocked.</p>` +
    (meta?.aops ?? []).map((a) => `<div class="aop"><strong>${esc(a.title)}</strong> <span class="muted">· ${esc(a.id)} v${esc(a.version)} · #${esc(a.hash)}</span>
      <div class="muted">${esc(a.triggers)}</div>
      <ol>${a.steps.map((s) => `<li><b>${esc(s.title)}.</b> ${esc(s.text).replace(/`([a-z_]+)`/g, "<code>$1</code>")}</li>`).join("")}</ol>
      <div>Tools: ${a.tools.map((t) => `<code>${esc(t)}</code>`).join(" ")}</div></div>`).join("");
}

function renderAccounts() {
  $("#accounts").innerHTML = (meta?.demo_accounts ?? []).map((a) =>
    `<button type="button" class="account" data-text="My order is ${esc(a.order_id)} and my email is ${esc(a.email)}."><b>${esc(a.order_id)}</b><span>${esc(a.name)} · ${esc(a.email)} · ${esc(a.status)}</span><span class="hint">${esc(a.items)}${a.hint ? ` — try: ${esc(a.hint)}` : ""}</span></button>`).join("");
  for (const b of document.querySelectorAll(".account")) b.onclick = () => { const i = $("#input"); i.value = b.dataset.text; autosize(); updateCounter(); i.focus(); };
}

// --- composer ------------------------------------------------------------------

function autosize() {
  const i = $("#input");
  i.style.height = "auto";
  i.style.height = `${i.scrollHeight + 2}px`; // CSS max-height caps it at ~5 rows
}

function updateCounter(flag) {
  const len = $("#input").value.length;
  const c = $("#counter");
  const over = len > MAX_LEN;
  c.classList.toggle("hidden", len < COUNTER_FROM);
  c.classList.toggle("over", over);
  c.textContent = over
    ? `${len.toLocaleString()} / ${MAX_LEN.toLocaleString()}: too long by ${(len - MAX_LEN).toLocaleString()} characters. Shorten it to send.`
    : `${len.toLocaleString()} / ${MAX_LEN.toLocaleString()}`;
  $("#input").setAttribute("aria-invalid", over ? "true" : "false");
  if (flag && over) $("#input").focus();
}

// --- tabs ----------------------------------------------------------------------

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab, focus) {
  for (const t of tabs) {
    const on = t === tab;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.tabIndex = on ? 0 : -1;
    $(`#${t.getAttribute("aria-controls")}`).classList.toggle("hidden", !on);
  }
  if (focus) tab.focus();
  if (tab.dataset.tab === "trace") positionTrace();
}
for (const tab of tabs) {
  tab.onclick = () => selectTab(tab);
  tab.onkeydown = (e) => {
    const i = tabs.indexOf(tab);
    const next = { ArrowRight: tabs[(i + 1) % tabs.length], ArrowLeft: tabs[(i - 1 + tabs.length) % tabs.length], Home: tabs[0], End: tabs[tabs.length - 1] }[e.key];
    if (next) { e.preventDefault(); selectTab(next, true); }
  };
}

// --- wiring --------------------------------------------------------------------

$("#tab-trace").addEventListener("scroll", (e) => {
  const el = e.currentTarget;
  traceStick = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}, { passive: true });

$("#composer").onsubmit = (e) => { e.preventDefault(); send($("#input").value); };
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); }
});
$("#input").addEventListener("input", () => { autosize(); updateCounter(); });
$("#new-conv").onclick = () => newConversation();

if (matchMedia("(max-width: 860px)").matches) $(".accounts").open = false;

render();
try {
  meta = await api("/api/meta");
  $("#meta").innerHTML = [meta.model, `effort ${meta.effort}`, `guardrails ${meta.guardrails}`, `prompt ${meta.prompt_version}`, `AOPs #${meta.aop_set}`].map((m) => `<span>${esc(m)}</span>`).join("");
  renderAccounts();
  renderAops();
} catch (e) {
  addSystem(friendly(e, "Couldn't reach Pine to load the demo."), { label: "Reload", run: () => location.reload() });
}
await restoreOrStart();
