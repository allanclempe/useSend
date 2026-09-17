import { createHmac, generateKeyPairSync, scryptSync } from "node:crypto";
import nodemailer from "nodemailer";
import Stripe from "stripe";
import { createSecureHash, verifySecureHash } from "~/server/crypto";
import { buildHeaders } from "~/server/utils/email-headers";

/**
 * Runs the §8 "runtime compatibility gotchas" list inside a real `workerd`
 * isolate and reports what happened.
 *
 * This is a fixture, not part of the API. It exists because the difference
 * between "the docs say `node:crypto` is supported" and "this codebase's
 * actual call runs" is the entire question, and two of these — the nodemailer
 * MIME build and Stripe's synchronous webhook verification — fail silently or
 * not at all depending on details no document covers.
 *
 * Run it with `pnpm --filter=web compat:check` and curl `/`. It is never
 * deployed; see `wrangler.compat-check.jsonc`.
 */

type CheckResult = {
  name: string;
  /** Where the real code lives, so a failure is actionable. */
  source: string;
  ok: boolean;
  /** Median wall-clock ms over `runs`, when timed. */
  ms?: number;
  runs?: number;
  detail: string;
};

async function check(
  name: string,
  source: string,
  fn: () => Promise<string> | string,
): Promise<CheckResult> {
  try {
    return { name, source, ok: true, detail: await fn() };
  } catch (error) {
    return {
      name,
      source,
      ok: false,
      detail: `${(error as Error).name}: ${(error as Error).message}`,
    };
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Wall clock, not CPU. Workers clamps `Date.now()` between I/O, but a purely
 *  synchronous block still advances it, which is what all of these are. */
function timed(runs: number, fn: () => void): { ms: number; runs: number } {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = Date.now();
    fn();
    samples.push(Date.now() - start);
  }
  return { ms: median(samples), runs };
}

/** `node -e "scryptSync(new TextEncoder().encode('a-token'), 'a-salt', 64)"`. */
const NODE_SCRYPT_REFERENCE =
  "f8dd945785b91d0c4ad7d48c137cea2b3343e90711e087b73629e4339e97278238b6d9b5a1d8f608447399b3db33aa52b9570dfe8386e2380fbad88c63f5ab02";

const SAMPLE_HTML =
  "<html><body><h1>Hello</h1>" + "<p>lorem ipsum dolor sit amet</p>".repeat(200) +
  "</body></html>";

async function runChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // ---------------------------------------------------------------- scrypt
  // §8 and issue #48: 18.7ms under Node, and 97% of a transactional send's
  // CPU. The question here is only whether it runs, and whether Workers makes
  // it worse.
  const scryptTiming = timed(11, () => {
    scryptSync(new TextEncoder().encode("a-token"), "a-salt", 64);
  });
  results.push({
    ...(await check("scryptSync", "server/crypto.ts", () => {
      const hash = scryptSync(
        new TextEncoder().encode("a-token"),
        "a-salt",
        64,
      ).toString("hex");

      // Node's output for the same inputs at its defaults (N=16384 r=8 p=1).
      // `crypto.ts` passes no options, so if workerd picked different defaults
      // this would differ and every API key hash already in the database would
      // stop verifying — a silent, total auth outage at cutover.
      if (hash !== NODE_SCRYPT_REFERENCE) {
        throw new Error(
          `scrypt output differs from Node's: got ${hash.slice(0, 32)}…`,
        );
      }
      return "byte-identical to Node at the same defaults";
    })),
    ms: scryptTiming.ms,
    runs: scryptTiming.runs,
  });

  // The round trip the public API actually performs on every request.
  results.push(
    await check(
      "createSecureHash / verifySecureHash round trip",
      "server/crypto.ts",
      async () => {
        const hash = await createSecureHash("a-token");
        const valid = await verifySecureHash("a-token", hash);
        const invalid = await verifySecureHash("wrong-token", hash);
        if (!valid || invalid) {
          throw new Error(
            `verifySecureHash is wrong: valid=${valid} invalid=${invalid}`,
          );
        }
        return "correct token verifies, wrong token does not";
      },
    ),
  );

  // -------------------------------------------------------------- BYODKIM
  const keypair = await check(
    "generateKeyPairSync (rsa 1024, BYODKIM)",
    "server/aws/ses.ts:56",
    () => {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 1024,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      if (!publicKey.includes("BEGIN PUBLIC KEY")) {
        throw new Error("public key is not SPKI PEM");
      }
      if (!privateKey.includes("BEGIN PRIVATE KEY")) {
        throw new Error("private key is not PKCS8 PEM");
      }
      return "spki/pkcs8 PEM produced";
    },
  );
  if (keypair.ok) {
    const { ms, runs } = timed(5, () => {
      generateKeyPairSync("rsa", {
        modulusLength: 1024,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
    });
    keypair.ms = ms;
    keypair.runs = runs;
  }
  results.push(keypair);

  // ------------------------------------------------------- nodemailer MIME
  // The flagged-unverified one. `sendRawEmail` builds the whole RFC 5322
  // message through nodemailer's stream transport and hands the bytes to SES.
  // If this does not run, the MIME build has to be rewritten.
  let mimeMs: number | undefined;
  const mime = await check(
    "nodemailer MIME build (stream transport)",
    "server/aws/ses.ts:183",
    async () => {
        const start = Date.now();
        const { message } = await nodemailer
          .createTransport({ streamTransport: true })
          .sendMail({
            from: "sender@example.com",
            to: ["recipient@example.com"],
            cc: ["cc@example.com"],
            bcc: ["bcc@example.com"],
            replyTo: ["reply@example.com"],
            subject: "compat check",
            text: "plain text body",
            html: SAMPLE_HTML,
            attachments: [
              {
                filename: "attachment.txt",
                content: btoa("x".repeat(256 * 1024)),
                encoding: "base64",
              },
            ],
            headers: buildHeaders({
              emailId: "compat-check",
              unsubUrl: "https://example.com/unsub",
              isBulk: true,
            }),
          });

        const chunks: Uint8Array[] = [];
        for await (const chunk of message as AsyncIterable<Uint8Array>) {
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        const ms = Date.now() - start;

        const text = bytes.subarray(0, 4096).toString("utf8");
        for (const required of [
          "MIME-Version: 1.0",
          "From: sender@example.com",
          "List-Unsubscribe",
        ]) {
          if (!text.includes(required)) {
            throw new Error(
              `built a message but it is missing "${required}" — silent corruption`,
            );
          }
        }

        mimeMs = ms;
        return `${bytes.length} bytes of RFC 5322, headers intact, including a 256 KB base64 attachment`;
    },
  );
  mime.ms = mimeMs;
  results.push(mime);

  // ------------------------------------------------------------- Stripe SDK
  const STRIPE_TEST_SECRET = "sk_test_compat_check";
  const WEBHOOK_SECRET = "whsec_compat_check";
  const payload = JSON.stringify({
    id: "evt_compat",
    object: "event",
    type: "invoice.paid",
    data: { object: { customer: "cus_compat" } },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  const header = `t=${timestamp},v1=${signature}`;

  results.push(
    await check(
      "Stripe.createFetchHttpClient()",
      "server/billing/payments.ts:14",
      () => {
        const stripe = new Stripe(STRIPE_TEST_SECRET, {
          httpClient: Stripe.createFetchHttpClient(),
        });
        if (typeof stripe.customers.create !== "function") {
          throw new Error("client constructed but has no resources");
        }
        return "constructed with the fetch HTTP client";
      },
    ),
  );

  // The default client. If this constructs, a missed `createFetchHttpClient()`
  // would not be caught at startup — it would fail on the first API call.
  results.push(
    await check(
      "Stripe default (node http) client construction",
      "server/billing/payments.ts:14",
      () => {
        const stripe = new Stripe(STRIPE_TEST_SECRET);
        return `constructed: ${typeof stripe.customers.create === "function"}`;
      },
    ),
  );

  // The one the issue calls "silently broken if missed". `constructEvent` is
  // synchronous and needs a synchronous HMAC.
  results.push(
    await check(
      "stripe.webhooks.constructEvent (sync, current code)",
      "app/api/webhook/stripe/route.ts:45",
      () => {
        const stripe = new Stripe(STRIPE_TEST_SECRET, {
          httpClient: Stripe.createFetchHttpClient(),
        });
        const event = stripe.webhooks.constructEvent(
          payload,
          header,
          WEBHOOK_SECRET,
        );
        return `verified synchronously, event ${event.id}`;
      },
    ),
  );

  results.push(
    await check(
      "constructEventAsync + createSubtleCryptoProvider",
      "app/api/webhook/stripe/route.ts:45",
      async () => {
        const stripe = new Stripe(STRIPE_TEST_SECRET, {
          httpClient: Stripe.createFetchHttpClient(),
        });
        const event = await stripe.webhooks.constructEventAsync(
          payload,
          header,
          WEBHOOK_SECRET,
          undefined,
          Stripe.createSubtleCryptoProvider(),
        );
        return `verified, event ${event.id}`;
      },
    ),
  );

  // A bad signature must be rejected, or "it works" means nothing.
  results.push(
    await check(
      "constructEventAsync rejects a forged signature",
      "app/api/webhook/stripe/route.ts:45",
      async () => {
        const stripe = new Stripe(STRIPE_TEST_SECRET, {
          httpClient: Stripe.createFetchHttpClient(),
        });
        try {
          await stripe.webhooks.constructEventAsync(
            payload,
            `t=${timestamp},v1=${"0".repeat(64)}`,
            WEBHOOK_SECRET,
            undefined,
            Stripe.createSubtleCryptoProvider(),
          );
        } catch {
          return "rejected, as it must";
        }
        throw new Error("a forged signature was ACCEPTED");
      },
    ),
  );

  return results;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST a body here to find where the Workers request body limit bites.
    if (url.pathname === "/body-limit") {
      const body = await request.arrayBuffer();
      return Response.json({ bytesRead: body.byteLength });
    }

    const results = await runChecks();
    return Response.json(
      {
        runtime: typeof navigator !== "undefined" ? navigator.userAgent : "?",
        failed: results.filter((r) => !r.ok).map((r) => r.name),
        results,
      },
      { headers: { "content-type": "application/json; charset=utf-8" } },
    );
  },
};
