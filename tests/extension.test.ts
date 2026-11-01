import { test } from "node:test";
import assert from "node:assert/strict";
import { definition } from "../src/schema.js";
import { readConfig } from "../src/config.js";
import { TelegramClient, TelegramError } from "../src/client.js";
import { Transport, type Question } from "../src/transport.js";
import { executeAsk } from "../src/ask.js";
import { acquireLock } from "../src/lock.js";
import { randomUUID } from "node:crypto";

const config = { token: "secret", chat: "123", user: "123", timeout: 2, pollTimeout: 1 };
type Update = Record<string, unknown>;
class FakeApi {
  calls: { method: string; body: any }[] = [];
  updates: Update[] = [];
  wake?: () => void;
  nextMessage = 100;
  async call<T>(method: string, body: any, signal?: AbortSignal): Promise<T> {
    this.calls.push({ method, body });
    if (method === "getUpdates") {
      if (!this.updates.length && !signal?.aborted) await new Promise<void>(resolve => { this.wake = resolve; signal?.addEventListener("abort", () => resolve(), { once: true }); });
      const result = this.updates.splice(0); return result as T;
    }
    if (method === "sendMessage") return { message_id: this.nextMessage++ } as T;
    return true as T;
  }
  push(update: Update) { this.updates.push(update); this.wake?.(); this.wake = undefined; }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const q: Question = { question: "Which?", options: [{ title: "One" }, { title: "Zwei", description: "Detail" }], allowMultiple: false, allowFreeform: true };
const events = { emit() {} };
function setup() { const api = new FakeApi(); const t = new Transport(config, api as unknown as TelegramClient); t.start(); return { api, t }; }
function button(api: FakeApi, msg: number, row: number, from = 123, chat = 123, update = 1) {
  const send = api.calls.filter(x => x.method === "sendMessage")[msg - 100];
  return { update_id: update, callback_query: { id: `cb${update}`, from: { id: from }, message: { message_id: msg, chat: { id: chat, type: "private" } }, data: send.body.reply_markup.inline_keyboard[row][0].callback_data } };
}
function reply(msg: number, text: string, from = 123, chat = 123, update = 2) { return { update_id: update, message: { message_id: 999, chat: { id: chat, type: "private" }, from: { id: from }, reply_to_message: { message_id: msg }, text } }; }

test("schema matches reference shape and configuration rejects missing or invalid values", () => {
  assert.equal(definition.name, "ask_user"); assert.equal(definition.parameters.properties.questions.anyOf, undefined);
  assert.deepEqual(Object.keys(definition.parameters.properties), ["question", "questions", "context", "options", "allowMultiple", "allowFreeform", "allowComment", "displayMode", "singleSelectLayout", "contextExpanded", "overlayToggleKey", "commentToggleKey", "timeout"]);
  assert.throws(() => readConfig({}), /TOKEN/); assert.throws(() => readConfig({ PI_TELEGRAM_BOT_TOKEN: "secret", PI_TELEGRAM_CHAT_ID: "-1" }), /CHAT_ID/);
  assert.throws(() => readConfig({ PI_TELEGRAM_BOT_TOKEN: "secret", PI_TELEGRAM_CHAT_ID: "123" }), /USER_ID/);
  assert.throws(() => readConfig({ PI_TELEGRAM_BOT_TOKEN: "secret", PI_TELEGRAM_CHAT_ID: "123", PI_TELEGRAM_USER_ID: "123", PI_TELEGRAM_TIMEOUT_SECONDS: "0" }), /TIMEOUT/);
});
test("client sends HTTPS requests and redacts token from API failures", async () => {
  const calls: string[] = []; const api = new TelegramClient("sensitive", (async (url: string | URL | Request) => { calls.push(String(url)); return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 4 } }), { status: 429 }); }) as typeof fetch);
  await assert.rejects(api.call("sendMessage", {}), (e: TelegramError) => e.code === 429 && e.retryAfter === 4 && !e.message.includes("sensitive"));
  assert.match(calls[0], /^https:\/\/api\.telegram\.org\//);
});
test("complete selection flow authenticates and rejects duplicate and forged callbacks", async () => {
  const { api, t } = setup(); const result = executeAsk(t, "call", { question: "Which?", options: q.options }, undefined, "project", events, 2); await tick();
  api.push(button(api, 100, 0, 999, 123, 1)); api.push(button(api, 100, 0, 123, 999, 2));
  api.push({ ...button(api, 100, 0, 123, 123, 3), callback_query: { id: "forged", from: { id: 123 }, message: { message_id: 100, chat: { id: 123, type: "private" } }, data: "forged:o0" } });
  api.push(button(api, 100, 1, 123, 123, 4));
  const output = await result; assert.equal(output.content[0].text, "User answered: Zwei"); assert.deepEqual((output.details as any).response, { kind: "selection", selections: ["Zwei"] });
  api.push(button(api, 100, 0, 123, 123, 5)); await tick(); assert.equal(t.count, 0);
  assert.ok(api.calls.some(x => x.method === "answerCallbackQuery")); assert.ok(api.calls.some(x => x.method === "editMessageText")); assert.ok(api.calls.some(x => x.method === "getUpdates" && x.body.offset >= 5)); await t.dispose();
});
test("parallel questions accept replies out of order, only with correct reply and sender", async () => {
  const { api, t } = setup(); const a = t.ask("a", { ...q, options: [] }, false, false, "", new AbortController().signal, 1000); const b = t.ask("b", { ...q, options: [] }, false, false, "", new AbortController().signal, 1000); await tick();
  api.push(reply(100, "wrong", 999, 123, 1)); api.push(reply(999, "wrong", 123, 123, 2)); api.push(reply(101, "Grüße\nWelt", 123, 123, 3));
  assert.deepEqual(await b, { kind: "freeform", text: "Grüße\nWelt" }); assert.equal(t.count, 1); api.push(reply(100, " First ", 123, 123, 4)); assert.deepEqual(await a, { kind: "freeform", text: "First" }); await t.dispose();
});
test("multi-select requires confirmation and can add an optional comment", async () => {
  const { api, t } = setup(); const a = t.ask("a", { ...q, allowMultiple: true }, true, false, "", new AbortController().signal, 1000); await tick();
  api.push(button(api, 100, 0, 123, 123, 1)); api.push(button(api, 100, 1, 123, 123, 2)); api.push(button(api, 100, 2, 123, 123, 3)); await tick(); assert.equal(t.count, 1);
  api.push(reply(100, "Useful context", 123, 123, 4)); assert.deepEqual(await a, { kind: "selection", selections: ["One", "Zwei"], comment: "Useful context" }); await t.dispose();
});
test("custom text, batch skip, cancellation, abort and timeout", async () => {
  const { api, t } = setup(); const custom = t.ask("a", q, false, false, "", new AbortController().signal, 1000); await tick(); api.push(button(api, 100, 2)); await tick(); api.push(reply(100, "custom", 123, 123, 2)); assert.deepEqual(await custom, { kind: "freeform", text: "custom" });
  const batch = executeAsk(t, "b", { questions: [{ question: "First" }, { question: "Second" }] }, undefined, "", events, 2); await tick(); api.push(button(api, 101, 0, 123, 123, 3)); await tick(); api.push(reply(102, "answer", 123, 123, 4)); const result = await batch; assert.match(result.content[0].text, /1\. First → \(skipped\)/);
  const c = t.ask("c", q, false, false, "", new AbortController().signal, 1000); await tick(); api.push(button(api, 103, 3, 123, 123, 5)); assert.equal(await c, null);
  const controller = new AbortController(); const d = t.ask("d", q, false, false, "", controller.signal, 1000); controller.abort(); assert.equal(await d, null);
  assert.equal(await t.ask("e", q, false, false, "", new AbortController().signal, 10), null); await t.dispose();
});
test("validation and disposal release pending work", async () => {
  const { t } = setup(); await assert.rejects(executeAsk(t, "x", { questions: [{ question: "same" }, { question: "SAME" }] }, undefined, "", events, 2), /repeats/);
  const pending = t.ask("x", q, false, false, "", new AbortController().signal, 1000); await tick(); await t.dispose(); assert.equal(await pending, null);
});
test("one local owner per token and explicit release", () => {
  const token = randomUUID(); const release = acquireLock(token); assert.throws(() => acquireLock(token), /poller/); release(); const next = acquireLock(token); next();
});
test("poller reports a competing consumer without fabricating an answer", async () => {
  const api = new FakeApi(); api.call = async <T>(method: string, body: any, signal?: AbortSignal): Promise<T> => {
    if (method === "getUpdates") { await tick(); throw new TelegramError(409); }
    return FakeApi.prototype.call.call(api, method, body, signal) as Promise<T>;
  };
  const t = new Transport(config, api as unknown as TelegramClient); t.start();
  const pending = t.ask("a", q, false, false, "", new AbortController().signal, 1000);
  assert.equal(await pending, null); assert.match(t.failure!, /409/); assert.equal(t.count, 0); await assert.rejects(t.ask("b", q, false, false, "", new AbortController().signal, 1000), /409/); await t.dispose();
});
test("temporary polling errors recover and advance offsets", async () => {
  const api = new FakeApi(); let first = true; api.call = async <T>(method: string, body: any, signal?: AbortSignal): Promise<T> => {
    if (method === "getUpdates" && first) { first = false; throw new TelegramError(429, 1); }
    return FakeApi.prototype.call.call(api, method, body, signal) as Promise<T>;
  };
  const t = new Transport(config, api as unknown as TelegramClient); t.start(); const p = t.ask("a", q, false, false, "", new AbortController().signal, 2500); await tick(); api.push(button(api, 100, 0, 123, 123, 42));
  assert.deepEqual(await p, { kind: "selection", selections: ["One"] }); await tick(); assert.ok(api.calls.some(x => x.method === "getUpdates" && x.body.offset === 43)); await t.dispose();
});
for (const code of [0, 500]) test(`transient polling error ${code} retries in the same transport`, async () => {
  const api = new FakeApi(); let first = true;
  api.call = async <T>(method: string, body: any, signal?: AbortSignal): Promise<T> => {
    if (method === "getUpdates" && first) { first = false; throw new TelegramError(code); }
    return FakeApi.prototype.call.call(api, method, body, signal) as Promise<T>;
  };
  const t = new Transport(config, api as unknown as TelegramClient); t.start();
  const pending = t.ask("a", q, false, false, "", new AbortController().signal, 2500); await tick(); api.push(button(api, 100, 0, 123, 123, 8));
  assert.deepEqual(await pending, { kind: "selection", selections: ["One"] }); assert.equal(t.failure, undefined); await t.dispose();
});
test("invalid polling data is terminal and cancels pending requests with a sanitized reason", async () => {
  const api = new FakeApi(); const original = api.call.bind(api);
  api.call = async <T>(method: string, body: any, signal?: AbortSignal): Promise<T> => {
    if (method === "getUpdates") { await tick(); return [null] as T; }
    return original<T>(method, body, signal);
  };
  const t = new Transport(config, api as unknown as TelegramClient); t.start();
  const pending = t.ask("a", q, false, false, "", new AbortController().signal, 1000);
  assert.equal(await pending, null); assert.match((await t.completion)!, /unexpectedly/); assert.equal(t.count, 0); await t.dispose();
});
for (const mode of ["resolve", "reject"]) test(`unexpected polling ${mode} is terminal and sanitized`, async () => {
  const t = new Transport(config, new FakeApi() as unknown as TelegramClient);
  (t as any).poll = mode === "resolve" ? async () => {} : async () => { throw new Error("secret token"); };
  t.start(); const reason = await t.completion;
  assert.match(reason!, /unexpectedly/); assert.doesNotMatch(reason!, /secret/); assert.equal(t.failure, reason); await t.dispose();
});

function completion(api: FakeApi, messageId: number) {
  return api.calls.filter(x => x.method === "editMessageText" && x.body.message_id === messageId && x.body.reply_markup.inline_keyboard.length === 0).at(-1)?.body;
}
test("completed selections retain each question, context and project and disable controls", async () => {
  const { api, t } = setup();
  const a = t.ask("a", { ...q, question: "First question", context: "First context" }, false, false, "Project A", new AbortController().signal, 1000);
  const b = t.ask("b", { ...q, question: "Second question", allowMultiple: true }, false, false, "Project B", new AbortController().signal, 1000);
  await tick(); api.push(button(api, 101, 0, 123, 123, 1)); api.push(button(api, 101, 1, 123, 123, 2)); api.push(button(api, 101, 2, 123, 123, 3));
  assert.deepEqual(await b, { kind: "selection", selections: ["One", "Zwei"] });
  api.push(button(api, 100, 1, 123, 123, 4)); assert.deepEqual(await a, { kind: "selection", selections: ["Zwei"] }); await tick();
  const first = completion(api, 100); const second = completion(api, 101);
  assert.match(first.text, /Pi — Answered/); assert.match(first.text, /Project A[\s\S]*First question[\s\S]*First context/); assert.match(first.text, /Selected:\n- Zwei/);
  assert.match(second.text, /Project B[\s\S]*Second question/); assert.match(second.text, /Selected:\n- One\n- Zwei/);
  assert.deepEqual(first.reply_markup.inline_keyboard, []); assert.deepEqual(second.reply_markup.inline_keyboard, []);
  const edits = api.calls.filter(x => x.method === "editMessageText" && x.body.message_id === 100).length;
  api.push(button(api, 100, 0, 123, 123, 5)); await tick(); assert.equal(api.calls.filter(x => x.method === "editMessageText" && x.body.message_id === 100).length, edits); await t.dispose();
});
test("free-text, cancellation and expiration preserve original messages without revealing answers", async () => {
  const { api, t } = setup();
  const free = t.ask("a", { ...q, question: "Private question", context: "Context", options: [] }, false, false, "", new AbortController().signal, 1000); await tick();
  api.push(reply(100, "sensitive response", 123, 123, 1)); assert.deepEqual(await free, { kind: "freeform", text: "sensitive response" });
  const cancelled = t.ask("b", { ...q, question: "Cancel question" }, false, false, "", new AbortController().signal, 1000); await tick(); api.push(button(api, 101, 3, 123, 123, 2)); assert.equal(await cancelled, null);
  const expired = t.ask("c", { ...q, question: "Expire question" }, false, false, "", new AbortController().signal, 15); assert.equal(await expired, null); await tick();
  const freeEdit = completion(api, 100); assert.match(freeEdit.text, /Answered[\s\S]*Private question[\s\S]*Context/); assert.match(freeEdit.text, /Answer received/); assert.doesNotMatch(freeEdit.text, /sensitive response/);
  assert.match(completion(api, 101).text, /Cancelled[\s\S]*Cancel question/); assert.match(completion(api, 102).text, /Expired[\s\S]*Expire question/);
  assert.deepEqual(completion(api, 102).reply_markup.inline_keyboard, []); await t.dispose();
});
test("near-limit questions remain intact when adding selected text would exceed Telegram's limit", async () => {
  const { api, t } = setup(); const longQuestion = "Q".repeat(3980);
  const result = t.ask("a", { ...q, question: longQuestion }, false, false, "", new AbortController().signal, 1000); await tick(); api.push(button(api, 100, 0)); await result; await tick();
  const sent = api.calls.find(x => x.method === "sendMessage")!.body.text as string; const edited = completion(api, 100).text as string;
  assert.ok(sent.length <= 4096); assert.ok(edited.length <= 4096); assert.ok(edited.includes(longQuestion)); assert.doesNotMatch(edited, /Selected:/); await t.dispose();
});
test("failed completion edit falls back to keyboard removal without invalidating the answer", async () => {
  const { api, t } = setup(); const original = api.call.bind(api);
  api.call = async <T>(method: string, body: any, signal?: AbortSignal): Promise<T> => {
    if (method === "editMessageText" && body.reply_markup.inline_keyboard.length === 0) { api.calls.push({ method, body }); throw new TelegramError(400); }
    return original<T>(method, body, signal);
  };
  const result = executeAsk(t, "a", { question: "Keep this question", options: q.options }, undefined, "", events, 2); await tick(); api.push(button(api, 100, 0));
  assert.equal((await result).content[0].text, "User answered: One"); await tick();
  assert.ok(api.calls.some(x => x.method === "editMessageReplyMarkup" && x.body.message_id === 100 && x.body.reply_markup.inline_keyboard.length === 0)); await t.dispose();
});
test("shutdown aborts a pending send and returns the existing cancellation result", async () => {
  const api = new FakeApi(); const original = api.call.bind(api); let sendAborted = false;
  api.call = async <T>(method: string, body: any, signal?: AbortSignal): Promise<T> => {
    if (method === "sendMessage") return new Promise<T>((_resolve, reject) => { signal?.addEventListener("abort", () => { sendAborted = true; reject(new Error("aborted")); }, { once: true }); });
    return original<T>(method, body, signal);
  };
  const t = new Transport(config, api as unknown as TelegramClient); t.start();
  const result = executeAsk(t, "a", { question: "Pending" }, undefined, "", events, 2); await tick(); await t.dispose();
  assert.equal(sendAborted, true); assert.equal((await result).content[0].text, "User cancelled the question");
});
