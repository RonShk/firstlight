// SMS delivery through Twilio's REST API. Configured only when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
// and TWILIO_FROM are set; otherwise sending fails and the outbox records it as undelivered.
import { appendMessage } from "../cases/repository";
import type { DeliveryAdapter } from "./outbox";

export function smsDelivery(env: Record<string, string | undefined> = process.env): DeliveryAdapter {
  return {
    async send(message, _record, db) {
      const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = env;
      if (!sid || !token || !from) throw new Error("SMS provider not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM)");
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        // Twilio deduplicates nothing; our outbox claims each message once, so a send is attempted at most MAX_ATTEMPTS times.
        body: new URLSearchParams({ To: message.recipient, From: from, Body: message.body }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Twilio HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      appendMessage(db, message.caseId, "agent", message.body, message.runId);
    },
  };
}
