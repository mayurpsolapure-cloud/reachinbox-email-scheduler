import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

let transporter: Transporter | null = null;
let senderEmail = "";

export async function initializeEmailService() {
  const account = await nodemailer.createTestAccount();

  senderEmail = account.user;

  transporter = nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: {
      user: account.user,
      pass: account.pass,
    },
  });

  await transporter.verify();

  console.log("Ethereal SMTP connected");
  console.log("Ethereal test sender:", senderEmail);
}

export function getSenderEmail(): string {
  if (!senderEmail) {
    throw new Error("Email service has not been initialized");
  }
  return senderEmail;
}

export async function sendTestEmail(
  recipient: string,
  subject: string,
  body: string
) {
  if (!transporter) {
    throw new Error("Email service has not been initialized");
  }

  const info = await transporter.sendMail({
    from: `"ReachInbox Scheduler" <${senderEmail}>`,
    to: recipient,
    subject,
    text: body,
    html: `<div>${body.replace(/\n/g, "<br>")}</div>`,
  });

  return {
    messageId: info.messageId,
    previewUrl: nodemailer.getTestMessageUrl(info),
  };
}