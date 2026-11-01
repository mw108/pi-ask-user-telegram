import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Option, Question, Response, Transport } from "./transport.js";

export type Params = { question?: string; questions?: Params[]; context?: string; options?: unknown[]; allowMultiple?: boolean; allowFreeform?: boolean; allowComment?: boolean; timeout?: number };
type Answer = { status: "answered"; response: Response } | { status: "skipped" };
const bool = (x?: string) => /^(true|1|yes|on)$/i.test(x?.trim() ?? "") ? true : /^(false|0|no|off)$/i.test(x?.trim() ?? "") ? false : undefined;
function preferences() {
  const path = join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "ask-user.json");
  let value: Record<string, unknown> = {};
  try { const raw = JSON.parse(readFileSync(path, "utf8")); if (raw && typeof raw === "object" && !Array.isArray(raw)) value = raw; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Failed to read or parse ask-user settings at ${path}`); }
  return { comment: bool(process.env.PI_ASK_USER_ALLOW_COMMENT) ?? (typeof value.allowComment === "boolean" ? value.allowComment : false), full: bool(process.env.PI_ASK_USER_EMIT_FULL_EVENTS) ?? (typeof value.emitFullEvents === "boolean" ? value.emitFullEvents : false) };
}
function options(raw: unknown[], label?: string): Option[] {
  const parsed = raw.map(item => {
    if (["string", "number", "boolean"].includes(typeof item)) { const title = String(item).trim(); return title ? { title } : null; }
    if (item && typeof item === "object") { const o = item as Record<string, unknown>; for (const key of ["title", "label", "text", "value", "name", "option"]) if (typeof o[key] === "string" && o[key].trim()) return { title: o[key].trim(), ...(typeof o.description === "string" && o.description.trim() ? { description: o.description } : {}) }; }
    return null;
  }).filter((x): x is Option => x !== null);
  if (raw.length && !parsed.length) throw new Error(`All ${raw.length} option(s)${label ? ` in ${label}` : ""} were malformed, so nothing could be shown to the user. Each option must be a plain string or an object like { "title": "Short label", "description": "Optional detail" }. Call ask_user again with corrected options.`);
  return parsed;
}
function normalize(p: Params): { questions: Question[]; heading?: string; batch: boolean } {
  if (p.questions != null) {
    const misplaced = (["context", "options", "allowMultiple", "allowFreeform"] as const).filter(k => p[k] != null);
    if (misplaced.length) throw new Error(`${misplaced.join(", ")} cannot be set at the top level together with questions. Set them on each questions entry instead.`);
    if (!Array.isArray(p.questions)) throw new Error("questions must be an array of 2-4 question objects.");
    if (p.questions.length < 2) throw new Error(`questions needs 2-4 entries but got ${p.questions.length}. To ask one question, use question instead.`);
    if (p.questions.length > 4) throw new Error(`questions accepts at most 4 entries but got ${p.questions.length}. Ask the rest in a later ask_user call.`);
    const seen = new Set<string>();
    const questions = p.questions.map((q, i) => {
      const label = `questions[${i}]`; const question = typeof q?.question === "string" ? q.question.trim() : "";
      if (!question) throw new Error(`${label}.question must be a non-empty string.`);
      if (seen.has(question.toLowerCase())) throw new Error(`${label} repeats the question "${question}". Each question in a batch must be distinct.`);
      seen.add(question.toLowerCase());
      if (q.options != null && !Array.isArray(q.options)) throw new Error(`${label}.options must be an array.`);
      return { question, context: typeof q.context === "string" ? q.context.trim() || undefined : undefined, options: options(q.options ?? [], label), allowMultiple: q.allowMultiple ?? false, allowFreeform: q.allowFreeform ?? true };
    });
    return { questions, heading: p.question?.trim() || undefined, batch: true };
  }
  if (typeof p.question !== "string") throw new Error("ask_user needs question (one focused question) or questions (2-4 independent questions).");
  return { questions: [{ question: p.question, context: p.context?.trim() || undefined, options: options(p.options ?? []), allowMultiple: p.allowMultiple ?? false, allowFreeform: p.allowFreeform ?? true }], batch: false };
}
const summary = (r: Response) => r.kind === "freeform" ? r.text : `${r.selections.join(", ")}${r.comment ? ` — ${r.comment}` : ""}`;
type Events = { emit: (name: string, data: unknown) => void };
export async function executeAsk(transport: Transport, callId: string, params: Params, signal: AbortSignal | undefined, project: string, events: Events, defaultTimeout: number) {
  if (signal?.aborted) return { content: [{ type: "text" as const, text: "Cancelled" }], details: params.questions != null ? { kind: "batch", questions: [], answers: [], cancelled: true } : { question: params.question, options: [], response: null, cancelled: true } };
  const { questions, heading, batch } = normalize(params); const pref = preferences();
  const subjects = questions.map(({ question, context, options }) => ({ question, context, options }));
  const deadline = Date.now() + Math.min(defaultTimeout * 1000, params.timeout && params.timeout > 0 ? params.timeout : Infinity);
  const controller = new AbortController(); const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  const answers: Answer[] = [];
  events.emit("herdr:blocked", { active: true, label: "Waiting for user response" });
  try {
    for (const q of questions) {
      const answer = await transport.ask(callId, q, params.allowComment ?? pref.comment, batch, project, controller.signal, Math.max(1, deadline - Date.now()));
      if (answer === null) {
        subjects.forEach((s, i) => events.emit("ask:cancelled", { question: s.question, ...(pref.full ? { context: s.context, options: s.options } : {}), ...(batch ? { batch: { index: i, total: questions.length } } : {}) }));
        return { content: [{ type: "text" as const, text: batch ? "User cancelled the questions" : "User cancelled the question" }], details: batch ? { kind: "batch", ...(heading ? { heading } : {}), questions: subjects, answers: [], cancelled: true } : { ...subjects[0], response: null, cancelled: true } };
      }
      answers.push(answer === "skip" ? { status: "skipped" } : { status: "answered", response: answer });
    }
    answers.forEach((a, i) => { if (a.status === "answered") events.emit("ask:answered", { question: subjects[i].question, ...(pref.full ? { context: subjects[i].context, response: a.response } : { response: { kind: a.response.kind } }), ...(batch ? { batch: { index: i, total: questions.length } } : {}) }); });
    if (!batch) { const response = (answers[0] as { status: "answered"; response: Response }).response; return { content: [{ type: "text" as const, text: `User answered: ${summary(response)}` }], details: { ...subjects[0], response, cancelled: false } }; }
    const lines = subjects.map((s, i) => `${i + 1}. ${s.question} → ${answers[i].status === "answered" ? summary((answers[i] as { status: "answered"; response: Response }).response) : "(skipped)"}`);
    return { content: [{ type: "text" as const, text: [...(heading ? [heading] : []), `User answered ${answers.filter(a => a.status === "answered").length} of ${questions.length} questions:`, ...lines].join("\n") }], details: { kind: "batch", ...(heading ? { heading } : {}), questions: subjects, answers, cancelled: false } };
  } finally { signal?.removeEventListener("abort", abort); events.emit("herdr:blocked", { active: false }); }
}
