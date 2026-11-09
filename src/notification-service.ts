import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Transport } from "./transport.js";

export const NOTIFICATION_CHANNEL = "pi-ask-user-telegram:notification-service:v1";
export const ACTION_NOTIFICATION_CHANNEL = "pi-ask-user-telegram:notification-service:v2";

export interface NotificationService {
  readonly protocolVersion: 1;
  notify(text: string): Promise<void>;
}

export interface ActionNotificationService {
  readonly protocolVersion: 2;
  notifyAction(text: string, action: { id: string; label: string; expiresAt: number }, handler: () => Promise<string>): Promise<void>;
}

export function registerNotificationService(pi: ExtensionAPI, lifecycle: { readonly transport?: Transport }) {
  const service: NotificationService = {
    protocolVersion: 1,
    async notify(text) {
      const transport = lifecycle.transport;
      if (!transport) throw new Error("Telegram notification transport unavailable");
      await transport.notify(text);
    },
  };
  const off = pi.events.on(NOTIFICATION_CHANNEL, value => {
    const request = value as { protocolVersion?: number; accept?: (service: NotificationService) => void } | undefined;
    if (request?.protocolVersion === 1 && typeof request.accept === "function") request.accept(service);
  });
  const offActions = pi.events.on(ACTION_NOTIFICATION_CHANNEL, value => {
    const request = value as { protocolVersion?: number; accept?: (service: unknown) => void } | undefined;
    if (request?.protocolVersion !== 2 || typeof request.accept !== "function") return;
    const service: ActionNotificationService = { protocolVersion: 2, async notifyAction(text, action, handler) {
      const transport = lifecycle.transport;
      if (!transport) throw new Error("Telegram notification transport unavailable");
      await transport.notifyAction(text, action.label, action.id, action.expiresAt, handler);
    } };
    request.accept(service);
  });
  return () => { off(); offActions(); };
}
