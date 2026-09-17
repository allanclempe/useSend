/**
 * CPU cost of one send and one event.
 *
 * Run with `pnpm --filter=web bench:cpu`. It is excluded from every test suite
 * — `vitest.bench.config.ts` is the only config that picks up `*.bench.ts`.
 *
 * Why this exists: `references/serverless-migration.md` §12 prices the
 * migration off an *estimated* ~35 CPU-ms per email. Cloudflare bills CPU time,
 * so that number is load-bearing and nobody had measured it. See issue #7.
 *
 * What is measured, and what is not:
 *
 * - `process.cpuUsage()` (user + system) is the billable axis — it is the Node
 *   analogue of what Cloudflare meters. `performance.now()` is reported beside
 *   it only to show how much of the wall time is not CPU.
 * - Every measured function is pure compute. No database, no network, no queue.
 *   Anything that awaits I/O is excluded on purpose: Workers does not bill it.
 * - Each case runs `repeats` invocations inside one timed sample so that a
 *   sample is comfortably above the microsecond resolution of `cpuUsage()`,
 *   then divides. The distribution is over `iterations` such samples.
 *
 * Read the caveats printed at the end of the run before quoting any number.
 */

import os from "node:os";
import { performance } from "node:perf_hooks";

import { EmailRenderer } from "@usesend/email-editor/src/renderer";
import { convert as htmlToText } from "html-to-text";
import nodemailer from "nodemailer";
import { createHmac, scryptSync } from "node:crypto";
import { describe, it } from "vitest";

import { createSecureHash, verifySecureHash } from "~/server/crypto";
import { renderOtpEmail } from "~/server/email-templates/OtpEmail";
import {
  buildNewsletterDoc,
  buildSnsEventBody,
  campaignRenderOptions,
  doubleOptInDoc,
  type EditorDocument,
} from "./payloads";

type Stats = {
  name: string;
  bytes?: number;
  cpuMs: Distribution;
  wallMs: Distribution;
};

type Distribution = {
  min: number;
  median: number;
  p95: number;
  max: number;
};

const results: Stats[] = [];

function percentile(sorted: number[], fraction: number) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index] as number;
}

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] as number,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] as number,
  };
}

async function measure(
  name: string,
  fn: () => unknown | Promise<unknown>,
  options: {
    iterations?: number;
    repeats?: number;
    warmup?: number;
    bytes?: number;
  } = {},
) {
  const { iterations = 40, repeats = 1, warmup = 10, bytes } = options;

  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  const cpuSamples: number[] = [];
  const wallSamples: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();

    for (let r = 0; r < repeats; r++) {
      await fn();
    }

    const wallDelta = performance.now() - wallStart;
    const cpuDelta = process.cpuUsage(cpuStart);

    cpuSamples.push((cpuDelta.user + cpuDelta.system) / 1000 / repeats);
    wallSamples.push(wallDelta / repeats);
  }

  const stats: Stats = {
    name,
    bytes,
    cpuMs: distribution(cpuSamples),
    wallMs: distribution(wallSamples),
  };

  results.push(stats);
  return stats;
}

function fmt(value: number) {
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

function bytesOf(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function kb(bytes?: number) {
  return bytes === undefined ? "—" : `${(bytes / 1024).toFixed(1)} KB`;
}

function report() {
  const lines: string[] = [];

  lines.push("");
  lines.push(`node            ${process.version}`);
  lines.push(`platform        ${os.platform()} ${os.arch()}`);
  lines.push(`cpu             ${os.cpus()[0]?.model ?? "unknown"}`);
  lines.push(`cores           ${os.cpus().length}`);
  lines.push("");
  lines.push(
    "| Step | Payload | CPU min | CPU median | CPU p95 | CPU max | Wall median |",
  );
  lines.push("|---|---|---|---|---|---|---|");

  for (const row of results) {
    lines.push(
      `| ${row.name} | ${kb(row.bytes)} | ${fmt(row.cpuMs.min)} | **${fmt(
        row.cpuMs.median,
      )}** | ${fmt(row.cpuMs.p95)} | ${fmt(row.cpuMs.max)} | ${fmt(
        row.wallMs.median,
      )} |`,
    );
  }

  lines.push("");
  lines.push("All figures are milliseconds per single invocation.");
  lines.push("");

  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

function medianOf(name: string) {
  const row = results.find((result) => result.name === name);
  if (!row) {
    throw new Error(`No benchmark named "${name}"`);
  }
  return row.cpuMs.median;
}

/**
 * `sendRawEmail` (`server/aws/ses.ts:183`) builds the full RFC 5322 message
 * with nodemailer's stream transport before handing it to SES. That is real
 * per-send CPU — quoted-printable encoding of the body, base64 of every
 * attachment — and it happens on every send, transactional or campaign.
 */
async function buildMime(input: {
  html: string;
  text?: string;
  attachments?: Array<{ filename: string; content: string }>;
}) {
  const { message } = await nodemailer
    .createTransport({ streamTransport: true })
    .sendMail({
      from: "useSend <hello@mail.example.com>",
      to: ["casey@example.com"],
      subject: "The useSend monthly — September",
      html: input.html,
      text: input.text,
      attachments: input.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        encoding: "base64",
      })),
      headers: {
        "X-Usesend-Email-ID": "clv9k2x4a0001qz3h8f7d2n5p",
        "List-Unsubscribe": "<https://usesend.com/unsubscribe?id=c_01HQ8Z9>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        Precedence: "bulk",
      },
    });

  const chunks: Buffer[] = [];
  for await (const chunk of message) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Mirrors `getEmailStatus` / `getEmailData` in `service/ses-hook-parser.ts:614`.
 * They are module-private there, and importing the module would drag in the
 * database, the queue and `env`. This is a nine-branch string comparison; it is
 * reproduced rather than imported so the benchmark stays free of I/O, and its
 * cost is negligible next to the `JSON.parse` it sits behind.
 */
const SES_STATUS: Record<string, string> = {
  Send: "SENT",
  Delivery: "DELIVERED",
  Bounce: "BOUNCED",
  Complaint: "COMPLAINED",
  Reject: "REJECTED",
  Open: "OPENED",
  Click: "CLICKED",
  "Rendering Failure": "RENDERING_FAILURE",
  DeliveryDelay: "DELIVERY_DELAYED",
};

function deriveEvent(rawBody: string) {
  const envelope = JSON.parse(rawBody) as { Message: string };
  const event = JSON.parse(envelope.Message) as {
    eventType: string;
    mail: {
      messageId: string;
      headers: Array<{ name: string; value: string }>;
    };
  };

  const status = SES_STATUS[event.eventType];
  const data =
    event.eventType === "Rendering Failure"
      ? (event as Record<string, unknown>).renderingFailure
      : event.eventType === "DeliveryDelay"
        ? (event as Record<string, unknown>).deliveryDelay
        : (event as Record<string, unknown>)[event.eventType.toLowerCase()];

  const header = event.mail.headers.find(
    (h) => h.name === "X-Usesend-Email-ID" || h.name === "X-Unsend-Email-ID",
  );

  return { status, data, sesEmailId: event.mail.messageId, header };
}

/** `signBody` + `stringifyPayload` from `service/webhook-service.ts:1035`. */
function signWebhook(payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const hmac = createHmac("sha256", "whsec_2f6a1c8e5d40b1d0f7a4a8e4c1f9d3b2");
  hmac.update(`${timestamp}.${body}`);
  return `v1=${hmac.digest("hex")}`;
}

describe("CPU per send and per event", () => {
  it(
    "measures the hot paths and prints a report",
    { timeout: 600_000 },
    async () => {
      // ---------------------------------------------------------------- render
      const transactionalHtml = await renderOtpEmail({
        otpCode: "H4F2QK",
        loginUrl: "https://app.usesend.com/login/verify?token=h4f2qk9x2",
        hostName: "app.usesend.com",
      });

      const optInDoc: EditorDocument = doubleOptInDoc();
      const marketingDoc = buildNewsletterDoc(6);
      const largeDoc = buildNewsletterDoc(30);

      const optInHtml = await new EmailRenderer(optInDoc).render(
        campaignRenderOptions,
      );
      const marketingHtml = await new EmailRenderer(marketingDoc).render(
        campaignRenderOptions,
      );
      const largeHtml = await new EmailRenderer(largeDoc).render(
        campaignRenderOptions,
      );

      await measure(
        "jsx-email `render` — OtpEmail template",
        () =>
          renderOtpEmail({
            otpCode: "H4F2QK",
            loginUrl: "https://app.usesend.com/login/verify?token=h4f2qk9x2",
            hostName: "app.usesend.com",
          }),
        { bytes: bytesOf(transactionalHtml) },
      );

      await measure(
        "EmailRenderer.render — double opt-in (repo fixture)",
        () => new EmailRenderer(optInDoc).render(campaignRenderOptions),
        { bytes: bytesOf(optInHtml) },
      );

      await measure(
        "EmailRenderer.render — newsletter, 6 sections",
        () => new EmailRenderer(marketingDoc).render(campaignRenderOptions),
        { bytes: bytesOf(marketingHtml) },
      );

      await measure(
        "EmailRenderer.render — newsletter, 30 sections",
        () => new EmailRenderer(largeDoc).render(campaignRenderOptions),
        { iterations: 25, bytes: bytesOf(largeHtml) },
      );

      // ----------------------------------------------------------- html-to-text
      await measure(
        "html-to-text — transactional",
        () => htmlToText(transactionalHtml),
        { repeats: 5, bytes: bytesOf(transactionalHtml) },
      );

      await measure(
        "html-to-text — newsletter, 6 sections",
        () => htmlToText(marketingHtml),
        { repeats: 5, bytes: bytesOf(marketingHtml) },
      );

      await measure(
        "html-to-text — newsletter, 30 sections",
        () => htmlToText(largeHtml),
        { iterations: 25, bytes: bytesOf(largeHtml) },
      );

      // ------------------------------------------------------------- MIME build
      const attachment = Buffer.alloc(256 * 1024, 7).toString("base64");

      await measure(
        "MIME build — transactional",
        () => buildMime({ html: transactionalHtml }),
        { repeats: 5, bytes: bytesOf(transactionalHtml) },
      );

      await measure(
        "MIME build — newsletter, 6 sections",
        () =>
          buildMime({
            html: marketingHtml,
            text: htmlToText(marketingHtml),
          }),
        { repeats: 5, bytes: bytesOf(marketingHtml) },
      );

      await measure(
        "MIME build — newsletter, 30 sections",
        () => buildMime({ html: largeHtml, text: htmlToText(largeHtml) }),
        { iterations: 25, bytes: bytesOf(largeHtml) },
      );

      await measure(
        "MIME build — transactional + 256 KB attachment",
        () =>
          buildMime({
            html: transactionalHtml,
            attachments: [{ filename: "invoice.pdf", content: attachment }],
          }),
        { iterations: 25, bytes: bytesOf(attachment) },
      );

      // ----------------------------------------------------------------- scrypt
      const apiKeyToken = "3f0c4b4e1d2a4e6f9a8b7c6d5e4f3a2b";
      const storedHash = await createSecureHash(apiKeyToken);

      await measure(
        "scryptSync — createSecureHash (new API key)",
        () => createSecureHash(apiKeyToken),
        { iterations: 25, warmup: 3 },
      );

      await measure(
        "scryptSync — verifySecureHash (every API request)",
        () => verifySecureHash(apiKeyToken, storedHash),
        { iterations: 25, warmup: 3 },
      );

      // `server/crypto.ts` calls `scryptSync(data, salt, 64)` with no options,
      // so it inherits Node's defaults: N=16384, r=8, p=1, maxmem=32 MB. Those
      // cost parameters are the whole story, so spell them out and check the
      // cost matches — if this row diverges from the two above, the defaults
      // are not what we think they are.
      await measure(
        "scryptSync — N=16384 r=8 p=1 keylen=64 (Node defaults, explicit)",
        () =>
          scryptSync(apiKeyToken, "a3f1c9d2e6b48057", 64, {
            N: 16384,
            r: 8,
            p: 1,
          }),
        { iterations: 25, warmup: 3 },
      );

      // ------------------------------------------------------------- SES events
      for (const eventType of ["Delivery", "Open", "Click"] as const) {
        const body = buildSnsEventBody(eventType);
        await measure(
          `SES event parse + status derivation — ${eventType}`,
          () => deriveEvent(body),
          { repeats: 200, bytes: bytesOf(body) },
        );
      }

      const webhookPayload = {
        type: "email.delivered",
        created_at: "2026-09-17T09:14:23.871Z",
        attempt: 1,
        data: {
          emailId: "clv9k2x4a0001qz3h8f7d2n5p",
          from: "hello@mail.example.com",
          to: ["casey@example.com"],
          subject: "The useSend monthly — September",
          status: "DELIVERED",
          createdAt: "2026-09-17T09:14:22.123Z",
        },
      };

      await measure(
        "Webhook sign — JSON.stringify + HMAC-SHA256",
        () => signWebhook(webhookPayload),
        { repeats: 200 },
      );

      report();

      // ------------------------------------------------------------- roll-ups
      const scrypt = medianOf(
        "scryptSync — verifySecureHash (every API request)",
      );
      const mime = medianOf("MIME build — transactional");

      // `getTeamAndApiKey` (`service/api-service.ts:78`) runs `verifySecureHash`
      // on every public-API request and nothing caches the result, so one
      // `scryptSync` is charged per *request* — amortised over the batch when
      // `POST /emails/batch` carries up to 100 emails.
      const singleSend = mime + scrypt;
      const batchSend = mime + scrypt / 100;

      // Campaign sends are fanned out internally, so they pay no API auth.
      const campaignSend =
        medianOf("EmailRenderer.render — newsletter, 6 sections") +
        medianOf("html-to-text — newsletter, 6 sections") +
        medianOf("MIME build — newsletter, 6 sections");

      const perEvent =
        medianOf("SES event parse + status derivation — Open") +
        medianOf("Webhook sign — JSON.stringify + HMAC-SHA256");

      const EVENTS_PER_EMAIL = 3.5; // §12: Send + Delivery + Open + Click
      const eventPipeline = perEvent * EVENTS_PER_EMAIL;

      const rollup = [
        "| Roll-up (median CPU-ms) | Value |",
        "|---|---|",
        `| Transactional send, one per API request — MIME + \`verifySecureHash\` | ${fmt(singleSend)} |`,
        `| Transactional send, batch of 100 — MIME + \`verifySecureHash\`/100 | ${fmt(batchSend)} |`,
        `| Campaign send — render + html-to-text + MIME build | ${fmt(campaignSend)} |`,
        `| One SES event — parse + derive + webhook sign | ${fmt(perEvent)} |`,
        `| Event pipeline per email (× ${EVENTS_PER_EMAIL}) | ${fmt(eventPipeline)} |`,
        `| **Per transactional email, one per request** | **${fmt(singleSend + eventPipeline)}** |`,
        `| **Per transactional email, batched 100** | **${fmt(batchSend + eventPipeline)}** |`,
        `| **Per campaign email** | **${fmt(campaignSend + eventPipeline)}** |`,
        "",
        "Caveats — read before quoting:",
        "  1. Measured under Node on x86 Linux, NOT on a Workers isolate on",
        "     Cloudflare hardware. Treat as an order of magnitude, not a bill.",
        "  2. Excludes all I/O — no database, no SES call, no queue op. Workers",
        "     does not bill time awaiting I/O, so that omission is deliberate,",
        "     but it also means the DO/queue side of the cost model is untouched.",
        "  3. The loops run hot, so V8 is fully warmed. A cold Workers isolate",
        "     pays JIT warm-up that this does not capture.",
        "  4. `scryptSync` is the dominant term. It is pure compute in OpenSSL",
        "     rather than in V8, so it is the figure most likely to transfer",
        "     unchanged — but it is also the one worth re-measuring first.",
      ].join("\n");

      // eslint-disable-next-line no-console
      console.log(rollup);
    },
  );
});
