export class TelegramError extends Error {
  constructor(public code: number, public retryAfter?: number) { super(`Telegram API error ${code}`); }
}
export class TelegramClient {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  async call<T>(method: string, body: object, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(70000)]),
      });
    } catch { throw new TelegramError(0); }
    let result: { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } };
    try { result = await response.json() as typeof result; } catch { throw new TelegramError(response.status); }
    if (!response.ok || !result.ok) throw new TelegramError(result.error_code ?? response.status, result.parameters?.retry_after);
    return result.result as T;
  }
}
