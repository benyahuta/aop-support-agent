const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let meta = null;
let conv = null;
let busy = false;

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  $("#messages").appendChild(div);
  $("#messages").scrollTop = 1e9;
  return div;
}

async function newConversation() {
  conv = await api("/api/conversations", { method: "POST" });
  $("#messages").innerHTML = "";
  addMsg("agent", "Hi, I'm Pine from Larkspur & Pine. How can I help today?");
  render();
}

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true;
  $("#send").disabled = true;
  addMsg("customer", text);
  const typing = addMsg("agent typing", "Pine is working…");
  try {
    const res = await api(`/api/conversations/${conv.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    typing.remove();
    addMsg("agent", res.reply);
    const wasHandoff = conv.status === "handoff";
    conv = res;
    if (conv.status === "handoff" && !wasHandoff) addMsg("system", "Conversation handed off to a human specialist");
  } catch (e) {
    typing.remove();
    addMsg("system", e.message);
  } finally {
    busy = false;
    $("#send").disabled = false;
    $("#input").focus();
    render();
  }
}

async function decide(refundId, decision) {
  try {
    const res = await api(`/api/conversations/${conv.id}/refunds/${refundId}`, { method: "POST", body: JSON.stringify({ decision }) });
    conv = res;
    addMsg("agent", res.note);
    render();
  } catch (e) {
    addMsg("system", e.message);
  }
}

// --- ops rendering ---------------------------------------------------------

function render() {
  if (!conv) return;
  renderState();
  renderTrace();
  renderBackend();
}

function renderState() {
  const c = conv;
  const pills = [];
  pills.push(c.status === "handoff" ? `<span class="pill warn">● handed off</span>` : `<span class="pill ok">● agent active</span>`);
  pills.push(c.verified_customer ? `<span class="pill ok">verified: ${esc(c.verified_customer.name)}</span>` : `<span class="pill">not verified</span>`);
  pills.push(`<span class="pill">${c.usage.model_calls} model calls</span>`);
  pills.push(`<span class="pill">${(c.usage.input_tokens + c.usage.cache_read + c.usage.cache_write).toLocaleString()} in / ${c.usage.output_tokens.toLocaleString()} out tok</span>`);
  pills.push(`<span class="pill">$${c.usage.cost_usd.toFixed(4)}</span>`);
  let steps = `<span class="muted">No procedure loaded yet</span>`;
  const aop = meta?.aops.find((a) => a.id === c.active_aop);
  if (aop) {
    steps = `<span class="pill">${esc(aop.id)} v${aop.version}</span>` + aop.steps.map((s) => {
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
    case "guardrail": return [`Guardrail ${e.decision.toUpperCase()} · ${e.rule}${e.tool ? ` (${e.tool})` : ""}`, e.detail];
    case "handoff": return [`Handoff → ticket ${e.ticket_id} (${e.reason})`, e.summary];
    case "approval": return [`Human ${e.decision} refund ${e.refund_id}`, `by ${e.by}`];
    default: return [e.type, JSON.stringify(e)];
  }
}

function renderTrace() {
  const t0 = conv.trace[0]?.t ?? 0;
  let lastTurn = 0;
  const html = [];
  for (const e of conv.trace) {
    if (e.turn !== lastTurn) { html.push(`<li class="turn-sep">Turn ${e.turn}</li>`); lastTurn = e.turn; }
    const [k, body] = evLabel(e);
    const cls = `${e.type} ${e.decision ?? ""}`;
    html.push(`<li class="ev ${cls}"><div class="h"><span class="k">${esc(k)}</span><span class="t">+${((e.t - t0) / 1000).toFixed(1)}s</span></div>${body ? `<pre>${esc(body)}</pre>` : ""}</li>`);
  }
  $("#trace").innerHTML = html.join("") || `<li class="muted">Send a message to see the agent's trace: procedure, steps, tool calls, and guardrail decisions.</li>`;
  $("#tab-trace").scrollTop = 1e9;
}

function renderBackend() {
  const b = conv.backend;
  const refunds = b.refunds.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.order_id)}</td><td>$${r.amount.toFixed(2)}</td><td>${esc(r.reason)}</td><td>${esc(r.status)}${r.status === "pending_approval" && meta.ops_approval ? `<br><button class="approve" data-refund="${esc(r.id)}" data-d="approve">Approve</button><button class="deny" data-refund="${esc(r.id)}" data-d="deny">Deny</button>` : ""}</td><td>${esc(r.decided_by ?? "")}</td></tr>`).join("");
  const returns = b.returns.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.order_id)}</td><td>${esc(r.sku)}</td><td>${esc(r.reason)}</td></tr>`).join("");
  const tickets = b.tickets.map((t) => `<tr><td>${esc(t.id)}</td><td>${esc(t.reason)}</td><td>${esc(t.priority)}</td><td>${esc(t.summary)}</td></tr>`).join("");
  $("#tab-backend").innerHTML = `
    <p class="muted">Each conversation runs against its own freshly seeded copy of the store backend.</p>
    <h3>Refunds</h3>${b.refunds.some((r) => r.status === "pending_approval") ? `<p class="muted">Simulated ops: approve or deny as the human specialist would.</p>` : ""}<table><tr><th>ID</th><th>Order</th><th>Amount</th><th>Reason</th><th>Status</th><th>Decided by</th></tr>${refunds || `<tr><td colspan=6 class="muted">none</td></tr>`}</table>
    <h3>Returns</h3><table><tr><th>ID</th><th>Order</th><th>SKU</th><th>Reason</th></tr>${returns || `<tr><td colspan=4 class="muted">none</td></tr>`}</table>
    <h3>Handoff tickets</h3><table><tr><th>ID</th><th>Reason</th><th>Priority</th><th>Summary</th></tr>${tickets || `<tr><td colspan=4 class="muted">none</td></tr>`}</table>`;
  for (const btn of document.querySelectorAll("[data-refund]")) btn.onclick = () => decide(btn.dataset.refund, btn.dataset.d);
}

function renderAops() {
  $("#tab-aops").innerHTML = `<p class="muted">Procedures are written in plain markdown and compiled into validated steps. The agent loads one with <code>load_procedure</code>; action tools outside the loaded procedure are blocked.</p>` +
    meta.aops.map((a) => `<div class="aop"><strong>${esc(a.title)}</strong> <span class="muted">· ${esc(a.id)} v${a.version} · #${esc(a.hash)}</span>
      <div class="muted">${esc(a.triggers)}</div>
      <ol>${a.steps.map((s) => `<li><b>${esc(s.title)}.</b> ${esc(s.text).replace(/`([a-z_]+)`/g, "<code>$1</code>")}</li>`).join("")}</ol>
      <div>Tools: ${a.tools.map((t) => `<code>${esc(t)}</code>`).join(" ")}</div></div>`).join("");
}

function renderAccounts() {
  $("#accounts").innerHTML = meta.demo_accounts.map((a) =>
    `<button class="account" data-text="My order is ${esc(a.order_id)} and my email is ${esc(a.email)}."><b>${esc(a.order_id)}</b><span>${esc(a.name)} · ${esc(a.email)} · ${esc(a.status)}</span><span class="hint">${esc(a.items)}${a.hint ? ` — try: ${esc(a.hint)}` : ""}</span></button>`).join("");
  for (const b of document.querySelectorAll(".account")) b.onclick = () => { $("#input").value = b.dataset.text; $("#input").focus(); };
}

// --- wiring ------------------------------------------------------------------

for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll("[data-tab]")) t.classList.toggle("active", t === tab);
    for (const b of document.querySelectorAll(".tab-body")) b.classList.toggle("hidden", b.id !== `tab-${tab.dataset.tab}`);
  };
}
$("#composer").onsubmit = (e) => { e.preventDefault(); const v = $("#input").value; $("#input").value = ""; send(v); };
$("#new-conv").onclick = newConversation;

meta = await api("/api/meta");
$("#meta").innerHTML = [meta.model, `effort ${meta.effort}`, `guardrails ${meta.guardrails}`, `prompt ${meta.prompt_version}`, `AOPs #${meta.aop_set}`].map((m) => `<span>${esc(m)}</span>`).join("");
renderAccounts();
renderAops();
await newConversation();
