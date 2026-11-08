// Simulator delivery: the reply lands in the case's own thread, which the simulated phone displays.
import { appendMessage } from "../cases/repository";
import type { DeliveryAdapter } from "./outbox";

export const simulatorDelivery: DeliveryAdapter = {
  async send(message, _record, db) {
    appendMessage(db, message.caseId, "agent", message.body, message.runId);
  },
};
