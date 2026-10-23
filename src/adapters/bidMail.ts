import { createHmac, createHash } from "node:crypto";
export interface BidMailConfig {
  tenantId: string;
  origin: string;
  linkSecret: string;
  from?: string;
  replyTo?: string;
  apiKey?: string;
  send?: (mail: {
    to: string;
    subject: string;
    text: string;
    key: string;
  }) => Promise<string>;
}
export function bidMailConfig(): BidMailConfig | undefined {
  const e = process.env;
  if (!e.PM_BID_TENANT_ID || !e.PM_PUBLIC_ORIGIN || !e.BID_LINK_SECRET)
    return undefined;
  const u = new URL(e.PM_PUBLIC_ORIGIN);
  if (u.protocol !== "https:" && u.hostname !== "localhost")
    throw Error("Bid response origin must use HTTPS");
  return {
    tenantId: e.PM_BID_TENANT_ID,
    origin: u.origin,
    linkSecret: e.BID_LINK_SECRET,
    from: e.MAIL_FROM,
    replyTo: e.MAIL_REPLY_TO,
    apiKey: e.RESEND_API_KEY,
  };
}
export const bidToken = (c: BidMailConfig, id: string) =>
  createHmac("sha256", c.linkSecret)
    .update(c.tenantId + ":" + id)
    .digest("hex");
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const mailEnabled = (c?: BidMailConfig) =>
  Boolean(c && (c.send || (c.from && c.apiKey)));
export async function sendBid(
  c: BidMailConfig,
  mail: { to: string; subject: string; text: string; key: string },
): Promise<string> {
  if (c.send) return c.send(mail);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: "Bearer " + c.apiKey,
      "Content-Type": "application/json",
      "Idempotency-Key": mail.key,
    },
    body: JSON.stringify({
      from: c.from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      ...(c.replyTo ? { reply_to: c.replyTo } : {}),
    }),
  });
  if (!r.ok) throw Error("Email provider did not confirm acceptance.");
  const b = (await r.json()) as { id?: string };
  if (!b.id) throw Error("No provider receipt");
  return b.id;
}
