/**
 * Slack drafts. The system never posts; it creates a draft message the specialist
 * or lead sends. Backed by Novum's existing Slack connector pattern (slack_send_message_draft).
 */
import type { Notifier } from "../index.js";

export type DraftSink = (channelOrUser: string, text: string) => Promise<void>;

export class SlackDrafts implements Notifier {
  constructor(private sink: DraftSink) {}
  async draft(channelOrUser: string, text: string) {
    await this.sink(channelOrUser, text);
  }
}

export function exceptionsDigest(clientName: string, payDate: string, counts: { block: number; review: number; info: number }, link?: string): string {
  const head = counts.block + counts.review === 0 ? `QA passed for ${clientName} (pay date ${payDate}).` : `QA for ${clientName} (pay date ${payDate}): ${counts.block} block, ${counts.review} review.`;
  return link ? `${head} Queue: ${link}` : head;
}

export function missingInputsReminder(clientName: string, cutoffDate: string, items: string[]): string {
  return `${clientName}: ${items.length} item${items.length === 1 ? "" : "s"} still open before the ${cutoffDate} cutoff: ${items.join("; ")}.`;
}
