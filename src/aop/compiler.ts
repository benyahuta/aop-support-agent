// AOP compiler: turns plain-language Agent Operating Procedures (markdown with a
// small frontmatter block) into structured, validated procedures.
//
// Authors write prose; the compiler pulls out the machine-checkable parts:
//   - which tools the procedure may use (frontmatter `tools`, enforced at runtime)
//   - the ordered steps, and which tools each step references (`backticked` names)
//   - cross-references to other procedures (`refund_request`), checked for existence
// A broken AOP (unknown tool, a step using a tool the procedure doesn't allow,
// a dangling procedure reference, non-sequential steps) fails compilation, so it
// can never reach the agent.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface AopStep {
  n: number;
  title: string;
  text: string;
  tools: string[];
}

export interface CompiledAop {
  id: string;
  title: string;
  version: number;
  triggers: string;
  tools: string[];
  steps: AopStep[];
  policies: string[];
  procedureRefs: string[];
  hash: string;
  source: string;
}

export class AopCompileError extends Error {
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
  }
}

/** Tools that are always available, regardless of procedure. */
export const GLOBAL_TOOLS = ["load_procedure", "search_policy", "verify_identity", "escalate_to_human"];

export function parseFrontmatter(src: string, file: string): { meta: Record<string, string | string[]>; body: string } {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new AopCompileError(file, "missing frontmatter block");
  const meta: Record<string, string | string[]> = {};
  for (const line of m[1].split("\n")) {
    if (!line.trim()) continue;
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) throw new AopCompileError(file, `bad frontmatter line: ${line}`);
    const [, key, raw] = kv;
    const list = raw.match(/^\[(.*)\]$/);
    meta[key] = list ? list[1].split(",").map((s) => s.trim()).filter(Boolean) : raw.trim();
  }
  return { meta, body: m[2] };
}

function section(body: string, name: string): string {
  const re = new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m");
  return body.match(re)?.[1] ?? "";
}

function backticked(text: string): string[] {
  return [...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
}

export function compileAop(source: string, file: string, knownTools: Set<string>, knownAops: Set<string>): CompiledAop {
  const { meta, body } = parseFrontmatter(source, file);
  for (const key of ["id", "title", "version", "triggers", "tools"]) {
    if (!(key in meta)) throw new AopCompileError(file, `frontmatter missing "${key}"`);
  }
  const id = String(meta.id);
  if (!/^[a-z_]+$/.test(id)) throw new AopCompileError(file, `id must be snake_case: ${id}`);
  const version = Number(meta.version);
  if (!Number.isInteger(version)) throw new AopCompileError(file, "version must be an integer");
  const tools = Array.isArray(meta.tools) ? meta.tools : [meta.tools];
  for (const t of tools) {
    if (!knownTools.has(t)) throw new AopCompileError(file, `unknown tool in frontmatter: ${t}`);
  }

  // Steps: "N. **Title.** text" followed by optional indented sub-bullets.
  const stepsSrc = section(body, "Steps");
  if (!stepsSrc.trim()) throw new AopCompileError(file, "no ## Steps section");
  const steps: AopStep[] = [];
  for (const line of stepsSrc.split("\n")) {
    const head = line.match(/^(\d+)\.\s+\*\*(.+?)\*\*\s*(.*)$/);
    if (head) {
      steps.push({ n: Number(head[1]), title: head[2].replace(/\.$/, ""), text: head[3].trim(), tools: [] });
    } else if (line.trim() && steps.length) {
      steps[steps.length - 1].text += "\n" + line.trim();
    }
  }
  steps.forEach((s, i) => {
    if (s.n !== i + 1) throw new AopCompileError(file, `steps must be numbered 1..N (found ${s.n} at position ${i + 1})`);
  });

  const allowed = new Set([...tools, ...GLOBAL_TOOLS]);
  const procedureRefs = new Set<string>();
  const policies = section(body, "Policies").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());

  const classify = (token: string, where: string, step?: AopStep) => {
    if (knownTools.has(token)) {
      // Policies may name a disallowed tool ("do not call `issue_refund`"); steps may not.
      if (step && !allowed.has(token)) throw new AopCompileError(file, `${where} references tool \`${token}\` which is not in this procedure's tools list`);
      if (step && !step.tools.includes(token)) step.tools.push(token);
    } else if (knownAops.has(token)) {
      if (token !== id) procedureRefs.add(token);
    }
    // anything else is a literal (a status value like `stalled`) and is left alone
  };
  for (const s of steps) for (const t of backticked(s.text)) classify(t, `step ${s.n}`, s);
  for (const p of policies) for (const t of backticked(p)) classify(t, "policy");

  // A snake_case token that looks like a procedure reference but isn't one is
  // almost always a typo'd procedure id (e.g. `refund_requests`).
  for (const t of backticked(body)) {
    if (/_/.test(t) && !knownTools.has(t) && !knownAops.has(t) && !LITERALS.has(t)) {
      throw new AopCompileError(file, `unknown reference \`${t}\` (not a tool, procedure, or known literal)`);
    }
  }

  return {
    id,
    title: String(meta.title),
    version,
    triggers: String(meta.triggers),
    tools,
    steps,
    policies,
    procedureRefs: [...procedureRefs],
    hash: createHash("sha256").update(source).digest("hex").slice(0, 12),
    source,
  };
}

/** Status/field literals AOP authors may reference in backticks. */
const LITERALS = new Set(["pending_approval", "final_sale", "in_transit", "label_created"]);

export function loadAops(dir: string, knownTools: Set<string>): Map<string, CompiledAop> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_")).sort();
  const sources = files.map((f) => ({ file: f, src: readFileSync(path.join(dir, f), "utf8") }));
  // First pass: collect ids so cross-references can be validated.
  const ids = new Set(sources.map(({ file, src }) => String(parseFrontmatter(src, file).meta.id)));
  const out = new Map<string, CompiledAop>();
  for (const { file, src } of sources) {
    const aop = compileAop(src, file, knownTools, ids);
    if (out.has(aop.id)) throw new AopCompileError(file, `duplicate procedure id ${aop.id}`);
    out.set(aop.id, aop);
  }
  return out;
}

/** What the agent sees when it calls load_procedure. */
export function renderForAgent(aop: CompiledAop): string {
  const lines = [`PROCEDURE ${aop.id} (v${aop.version}): ${aop.title}`, "", "Steps:"];
  for (const s of aop.steps) lines.push(`${s.n}. ${s.title}. ${s.text}`);
  if (aop.policies.length) {
    lines.push("", "Policies:");
    for (const p of aop.policies) lines.push(`- ${p}`);
  }
  lines.push("", `Tools available in this procedure: ${aop.tools.join(", ")}. Pass aop_step with every action tool call.`);
  return lines.join("\n");
}

/** Short fingerprint of the whole AOP set, used to label eval runs. */
export function aopSetHash(aops: Map<string, CompiledAop>): string {
  const h = createHash("sha256");
  for (const id of [...aops.keys()].sort()) h.update(aops.get(id)!.hash);
  return h.digest("hex").slice(0, 8);
}
