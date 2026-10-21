/**
 * Slack notifier. Messages go to Novum people only (the specialist, the lead,
 * the pod channel); a message meant for a client is delivered to the specialist
 * as text to forward, never to the client. Every message is also recorded by the
 * jobs layer so the dashboard shows it whether or not Slack delivery is on.
 */
import type { Notifier } from "../index.js";

export type DraftSink = (channelOrUser: string, text: string) => Promise<void>;

/** Notifier over any sink (a test array, a database table, the Slack client below). */
export class SlackDrafts implements Notifier {
  constructor(private sink: DraftSink) {}
  async draft(channelOrUser: string, text: string) {
    await this.sink(channelOrUser, text);
  }
}

/** chat.postMessage with a bot token. `channelOrUser` is a channel id, a user id, or an @handle resolved by the caller. */
export class SlackWebApi implements Notifier {
  constructor(private botToken: string, private fetchImpl: typeof fetch = fetch) {}
  async draft(channelOrUser: string, text: string) {
    const res = await this.fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.botToken}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: channelOrUser, text, unfurl_links: false }),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) throw new Error(`Slack ${json.error ?? res.status}`);
  }
}

export function exceptionsDigest(clientName: string, payDate: string, counts: { block: number; review: number; info: number }, link?: string): string {
  const head = counts.block + counts.review === 0 ? `QA passed for ${clientName} (pay date ${payDate}).` : `QA for ${clientName} (pay date ${payDate}): ${counts.block} block, ${counts.review} review.`;
  return link ? `${head} Queue: ${link}` : head;
}

export function missingInputsReminder(clientName: string, cutoffDate: string, items: string[]): string {
  return `${clientName}: ${items.length} item${items.length === 1 ? "" : "s"} still open before the ${cutoffDate} cutoff: ${items.join("; ")}.`;
}
