export interface Config { token: string; chat: string; user: string; timeout: number; pollTimeout: number }

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.PI_TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chat = env.PI_TELEGRAM_CHAT_ID?.trim() ?? "";
  const user = env.PI_TELEGRAM_USER_ID?.trim() ?? "";
  if (!token) throw new Error("Missing PI_TELEGRAM_BOT_TOKEN");
  if (!/^[1-9]\d*$/.test(chat)) throw new Error("PI_TELEGRAM_CHAT_ID must be a positive private chat ID");
  if (!/^[1-9]\d*$/.test(user)) throw new Error("PI_TELEGRAM_USER_ID must be a positive user ID");
  const seconds = (key: string, fallback: number, max: number) => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${key} must be an integer from 1 to ${max}`);
    return value;
  };
  return { token, chat, user, timeout: seconds("PI_TELEGRAM_TIMEOUT_SECONDS", 3600, 86400), pollTimeout: seconds("PI_TELEGRAM_POLL_TIMEOUT_SECONDS", 30, 50) };
}
