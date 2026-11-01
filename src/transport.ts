import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import { TelegramClient, TelegramError } from "./client.js";

export type Response = { kind: "selection"; selections: string[]; comment?: string } | { kind: "freeform"; text: string };
export type Option = { title: string; description?: string };
export type Question = { question: string; context?: string; options: Option[]; allowMultiple: boolean; allowFreeform: boolean };
type Answer = Response | "skip" | null;
type Message = { message_id: number; chat: { id: number | string; type?: string }; from?: { id: number | string }; text?: string; reply_to_message?: { message_id: number } };
type Callback = { id: string; from: { id: number | string }; message?: Message; data?: string };
type Update = { update_id: number; message?: Message; callback_query?: Callback };
type Pending = { id: string; callId: string; q: Question; comment: boolean; skip: boolean; messageId?: number; text: string; phase: "select" | "text" | "comment"; selections: Set<number>; finish: (value: Answer, status: string) => void; fail: (message: string) => void; edit: Promise<void> };

export class Transport {
  private pending = new Map<string, Pending>();
  private stop = new AbortController();
  private offset = 0;
  private loop?: Promise<string | undefined>;
  private fatal?: string;
  private isDisposed = false;
  public connected = false;
  constructor(private config: Config, private api = new TelegramClient(config.token)) {}
  get count() { return this.pending.size; }
  get failure() { return this.fatal; }
  get disposed() { return this.isDisposed; }
  get completion() { return this.loop; }
  start() {
    if (this.loop) return;
    this.loop = this.poll().then(
      () => this.stop.signal.aborted ? undefined : this.terminate("Telegram polling stopped unexpectedly."),
      error => this.stop.signal.aborted ? undefined : this.terminate(this.failureReason(error)),
    );
  }
  private failureReason(error: unknown): string {
    if (error instanceof TelegramError) {
      if (error.code === 401) return "Telegram API HTTP 401: check the bot credentials.";
      if (error.code === 409) return "Telegram API HTTP 409: another polling consumer or webhook may be active.";
      if (error.code === 404) return "Telegram API HTTP 404: check the bot credentials.";
      if (error.code >= 400 && error.code < 500) return `Telegram API HTTP ${error.code}: polling cannot continue.`;
    }
    return "Telegram polling stopped unexpectedly; check connectivity and configuration.";
  }
  private terminate(reason: string): string {
    this.fatal = reason;
    this.connected = false;
    this.stop.abort();
    for (const p of [...this.pending.values()]) p.finish(null, "cancelled");
    return reason;
  }
  private async poll() {
    let delay = 1000;
    while (!this.stop.signal.aborted) {
      let updates: Update[];
      try {
        updates = await this.api.call<Update[]>("getUpdates", { offset: this.offset, timeout: this.config.pollTimeout, allowed_updates: ["message", "callback_query"] }, this.stop.signal);
      } catch (error) {
        this.connected = false;
        if (this.stop.signal.aborted) break;
        // The HTTP client wraps network failures as code 0; unknown exceptions
        // indicate an internal failure rather than a recoverable network error.
        if (!(error instanceof TelegramError) || (error.code !== 0 && error.code !== 429 && error.code < 500)) throw error;
        const wait = error.code === 429 && error.retryAfter ? Math.min(2147483647, Math.max(1000, error.retryAfter * 1000)) : delay;
        await new Promise<void>(resolve => { const timer = setTimeout(done, wait); const signal = this.stop.signal; function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); } signal.addEventListener("abort", done, { once: true }); });
        delay = Math.min(delay * 2, 30000);
        continue;
      }
      if (!Array.isArray(updates)) throw new Error("Invalid Telegram updates");
      this.connected = true; delay = 1000;
      for (const update of updates) {
        if (!update || !Number.isSafeInteger(update.update_id)) throw new Error("Invalid Telegram update");
        try { await this.dispatch(update); } finally { this.offset = Math.max(this.offset, update.update_id + 1); }
      }
    }
  }
  private keyboard(p: Pending) {
    const rows: { text: string; callback_data: string }[][] = [];
    if (p.phase === "select") {
      p.q.options.forEach((o, i) => rows.push([{ text: `${p.q.allowMultiple ? (p.selections.has(i) ? "✓ " : "○ ") : ""}${o.title}`, callback_data: `${p.id}:o${i}` }]));
      if (p.q.allowMultiple) rows.push([{ text: "Confirm selection", callback_data: `${p.id}:confirm` }]);
      if (p.q.allowFreeform) rows.push([{ text: "Type custom response", callback_data: `${p.id}:text` }]);
    }
    if (p.phase === "comment") rows.push([{ text: "Continue without comment", callback_data: `${p.id}:nocomment` }]);
    if (p.skip) rows.push([{ text: "Skip question", callback_data: `${p.id}:skip` }]);
    rows.push([{ text: "Cancel", callback_data: `${p.id}:cancel` }]);
    return { inline_keyboard: rows };
  }
  private message(p: Pending, project: string) {
    const q = p.q;
    const lines = ["Pi — User Input Required", ...(project ? [`Project: ${project}`] : []), "", q.question, ...(q.context ? ["", `Context:\n${q.context}`] : []), ...(q.options.length ? ["", ...q.options.map((o, i) => `${i + 1}. ${o.title}${o.description ? ` — ${o.description}` : ""}`)] : []), "", q.options.length ? "Choose below. Reply to this message when text is requested." : "Reply to this message with your answer."];
    return lines.join("\n");
  }
  private edit(p: Pending, status?: string, answer?: Answer) {
    if (p.messageId === undefined) return;
    const messageId = p.messageId;
    // Serialize edits so a late toggle cannot restore a completed keyboard.
    p.edit = p.edit.then(async () => {
      if (status) {
        const header = `Pi — ${status[0].toUpperCase()}${status.slice(1)}`;
        let text = header + p.text.slice(p.text.indexOf("\n"));
        const suffix = answer && answer !== "skip" && answer.kind === "selection"
          ? `\n\nSelected:\n${answer.selections.map(s => `- ${s}`).join("\n")}`
          : answer && answer !== "skip" && answer.kind === "freeform" ? "\n\nAnswer received." : "";
        if (text.length + suffix.length <= 4096) text += suffix;
        try {
          const signal = this.stop.signal.aborted ? AbortSignal.timeout(2000) : this.stop.signal;
          await this.api.call("editMessageText", { chat_id: this.config.chat, message_id: messageId, text, reply_markup: { inline_keyboard: [] } }, signal);
        } catch {
          // Cosmetic failures must not alter an answer. Try to disable controls independently.
          const signal = this.stop.signal.aborted ? AbortSignal.timeout(2000) : this.stop.signal;
          await this.api.call("editMessageReplyMarkup", { chat_id: this.config.chat, message_id: messageId, reply_markup: { inline_keyboard: [] } }, signal).catch(() => {});
        }
      } else if (this.pending.has(p.id)) await this.api.call("editMessageText", { chat_id: this.config.chat, message_id: messageId, text: `${p.text}${p.phase === "comment" ? "\n\nReply to add a comment, or continue without one." : p.phase === "text" ? "\n\nReply to this message with your answer." : ""}`, reply_markup: this.keyboard(p) }, this.stop.signal);
    }).catch(() => {});
  }
  async ask(callId: string, q: Question, comment: boolean, skip: boolean, project: string, signal: AbortSignal, timeoutMs: number): Promise<Answer> {
    if (this.fatal) throw new Error(this.fatal);
    if (signal.aborted || this.stop.signal.aborted) return null;
    const id = randomBytes(12).toString("base64url");
    return new Promise<Answer>((resolve, reject) => {
      let settled = false; let finalStatus = "cancelled"; let finalAnswer: Answer = null;
      const p: Pending = { id, callId, q, comment, skip, text: "", phase: q.options.length ? "select" : "text", selections: new Set(), edit: Promise.resolve(), fail: message => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", aborted); this.pending.delete(id); this.edit(p, "cancelled"); reject(new Error(message));
      }, finish: (answer, status) => {
        if (settled) return; settled = true; finalStatus = status; finalAnswer = answer; clearTimeout(timer); signal.removeEventListener("abort", aborted); this.pending.delete(id); this.edit(p, status, answer); resolve(answer);
      } };
      const aborted = () => p.finish(null, "cancelled");
      const timer = setTimeout(() => p.finish(null, "expired"), Math.max(1, timeoutMs));
      this.pending.set(id, p); signal.addEventListener("abort", aborted, { once: true });
      const text = p.text = this.message(p, project);
      if (text.length > 4096 || q.options.some(o => o.title.length > 100) || q.options.length > 90) {
        clearTimeout(timer); signal.removeEventListener("abort", aborted); this.pending.delete(id); reject(new Error("Question or options exceed Telegram's message or keyboard limits")); return;
      }
      void this.api.call<{ message_id: number }>("sendMessage", { chat_id: this.config.chat, text, reply_markup: this.keyboard(p) }, AbortSignal.any([signal, this.stop.signal])).then(message => {
        p.messageId = message.message_id;
        if (settled) this.edit(p, finalStatus, finalAnswer);
      }).catch(() => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", aborted); this.pending.delete(id); reject(new Error("Could not send Telegram question; check bot configuration and connectivity."));
      });
      if (signal.aborted) aborted();
    });
  }
  private async dispatch(update: Update) {
    const cb = update.callback_query;
    if (cb) {
      const [id, action] = (cb.data ?? "").split(":");
      const p = this.pending.get(id ?? "");
      const authorized = String(cb.from.id) === this.config.user && String(cb.message?.chat.id) === this.config.chat && cb.message?.chat.type === "private" && p?.messageId === cb.message?.message_id;
      // Acknowledge even invalid/stale callbacks without exposing request state.
      void this.api.call("answerCallbackQuery", { callback_query_id: cb.id }, this.stop.signal).catch(() => {});
      if (!authorized || !p || !action) return;
      if (action === "cancel") { p.finish(null, "cancelled"); return; }
      if (action === "skip" && p.skip) { p.finish("skip", "skipped"); return; }
      if (action === "nocomment" && p.phase === "comment") { p.finish({ kind: "selection", selections: this.selected(p) }, "answered"); return; }
      if (p.phase !== "select") return;
      if (action === "text" && p.q.allowFreeform) { p.phase = "text"; this.edit(p); return; }
      if (/^o\d+$/.test(action)) {
        const i = Number(action.slice(1)); if (!Number.isSafeInteger(i) || i >= p.q.options.length) return;
        if (p.q.allowMultiple) { p.selections.has(i) ? p.selections.delete(i) : p.selections.add(i); this.edit(p); return; }
        p.selections.add(i); this.selectedOrComment(p); return;
      }
      if (action === "confirm" && p.q.allowMultiple && p.selections.size) this.selectedOrComment(p);
      return;
    }
    const m = update.message;
    if (!m || String(m.chat.id) !== this.config.chat || m.chat.type !== "private" || String(m.from?.id) !== this.config.user || !m.reply_to_message || typeof m.text !== "string") return;
    const p = [...this.pending.values()].find(item => item.messageId === m.reply_to_message?.message_id);
    if (!p || p.phase === "select") return;
    const text = m.text.trim();
    if (p.phase === "comment") { const response: Response = { kind: "selection", selections: this.selected(p), ...(text ? { comment: text } : {}) }; p.finish(response, "answered"); }
    else if (text) p.finish({ kind: "freeform", text }, "answered");
  }
  private selected(p: Pending) { return p.q.options.filter((_, i) => p.selections.has(i)).map(o => o.title); }
  private selectedOrComment(p: Pending) {
    if (p.comment) { p.phase = "comment"; this.edit(p); } else p.finish({ kind: "selection", selections: this.selected(p) }, "answered");
  }
  async dispose() { this.isDisposed = true; this.stop.abort(); this.connected = false; for (const p of [...this.pending.values()]) p.finish(null, "cancelled"); await this.loop; }
}
