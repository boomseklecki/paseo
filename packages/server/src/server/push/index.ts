import type pino from "pino";

import { PushService, type PushPayload } from "./push-service.js";
import { PushTokenStore } from "./token-store.js";

export type { PushPayload };

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

export interface PushSendOptions {
  /**
   * Deliver only to devices whose client advertised this capability. The
   * websocket leg makes the same check per connection; a push has no connection
   * to check, so the store answers from what the client last said it understands.
   */
  requiredCapability?: string;
}

export interface PushNotifications {
  renew(token: string, capabilities?: readonly string[]): void;
  revoke(token: string): void;
  send(payload: PushPayload, options?: PushSendOptions): Promise<void>;
}

export type PushNotificationSender = Pick<PushNotifications, "send">;

export function createPushNotifications(options: {
  logger: pino.Logger;
  filePath: string;
  now?: () => number;
  deliver?: (tokens: string[], payload: PushPayload) => Promise<void>;
}): PushNotifications {
  const now = options.now ?? Date.now;
  const store = new PushTokenStore(options.logger, options.filePath, now, PUSH_TOKEN_LEASE_MS);
  const service = new PushService(options.logger, (token) => store.revokeToken(token));
  const deliver =
    options.deliver ??
    ((tokens: string[], payload: PushPayload) => service.sendPush(tokens, payload));

  return {
    renew(token, capabilities) {
      store.renewToken(token, capabilities);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    async send(payload, sendOptions) {
      const tokens = store.getActiveTokens(sendOptions?.requiredCapability);
      options.logger.info(
        { tokenCount: tokens.length, requiredCapability: sendOptions?.requiredCapability },
        "Sending push notification",
      );
      if (tokens.length === 0) return;
      await deliver(tokens, payload);
    },
  };
}
