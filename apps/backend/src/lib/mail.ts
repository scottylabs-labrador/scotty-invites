import { env } from "../env";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

/**
 * Sends via the Mailgun HTTP API (no SDK). Falls back to console logging when
 * MAIL_MODE=console or no API key is configured — codes are printed for local dev.
 */
export async function sendMail(msg: MailMessage): Promise<{ ok: boolean; detail?: string }> {
  if (env.mailMode === "console") {
    console.log(
      `\n━━━ [mail:console] to=${msg.to} subject="${msg.subject}"\n${msg.text}\n━━━ end mail\n`,
    );
    return { ok: true, detail: "console" };
  }

  const host = env.mailgunRegion === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
  const url = `https://${host}/v3/${env.mailgunDomain}/messages`;
  const form = new URLSearchParams();
  form.set("from", env.mailFrom);
  form.set("to", msg.to);
  form.set("subject", msg.subject);
  form.set("html", msg.html);
  form.set("text", msg.text);
  if (msg.replyTo) form.set("h:Reply-To", msg.replyTo);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${env.mailgunApiKey}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const body = await res.text();
    if (!res.ok) {
      // Truncate the provider body — it can echo recipient/message content.
      console.error(`[mail] mailgun ${res.status} for ${msg.to}: ${body.slice(0, 120)}`);
      return { ok: false, detail: `${res.status}` };
    }
    // Never log the subject — sign-in codes live in the subject line and this
    // runs in production (Mailgun) mode where logs are broadly readable.
    console.log(`[mail] sent to=${msg.to}`);
    return { ok: true };
  } catch (err) {
    console.error(`[mail] error sending to ${msg.to}:`, err);
    return { ok: false, detail: String(err) };
  }
}
