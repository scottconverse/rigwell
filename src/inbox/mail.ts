import nodemailer from "nodemailer";
import { secretValue } from "../secrets/store.ts";
import type { EmailConfig } from "./store.ts";

export interface AlertMessage { subject: string; text: string; id: string }
export async function sendSmtp(config: EmailConfig, message: AlertMessage, signal: AbortSignal, testTls?: { ca: string; servername: string }) {
  const password = secretValue(config.passwordCredential);
  if (!password) throw new Error("The stored SMTP password is missing");
  const transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure, requireTLS: !config.secure,
    auth: { user: config.user, pass: password }, tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, ...testTls },
    connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 15_000, dnsTimeout: 10_000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
  try {
    if (signal.aborted) throw new Error("Email delivery stopped");
    const result = await transport.sendMail({ from: config.from, to: config.to, subject: message.subject, text: message.text, messageId: `<${message.id}@rigwell.local>`, disableFileAccess: true, disableUrlAccess: true, signal });
    if (result.rejected?.length || !result.accepted?.length) throw new Error("SMTP did not accept the recipient");
  } finally { transport.close(); }
}
