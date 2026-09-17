/**
 * Payloads for the CPU benchmark (see `cpu-per-email.bench.ts`).
 *
 * Provenance is the point. A 200 byte email measures nothing, so every payload
 * below says where it came from and is sized to a class we actually send:
 *
 * - `transactional` — the repo's own `OtpEmail` jsx-email template, rendered.
 *   This is a real production email (`server/mailer.ts:33`), not a mock-up.
 * - `doubleOptIn` — `DEFAULT_DOUBLE_OPT_IN_CONTENT` verbatim from
 *   `lib/constants/double-opt-in.ts`. A real in-repo editor document, and the
 *   smallest campaign-shaped payload that exists.
 * - `marketing` / `large` — constructed here, because the repo ships no
 *   newsletter fixture. `buildNewsletterDoc()` repeats a section modelled on a
 *   typical marketing email: heading, two styled paragraphs with a tracked
 *   link, a bullet list, an image, a CTA button, a quote and a rule. Six
 *   sections is a normal newsletter; thirty is a long-form digest. Both carry
 *   `{{firstName}}` and `{{usesend_unsubscribe_url}}` so the variable
 *   substitution path in `EmailRenderer` runs, as it does for every campaign
 *   recipient.
 *
 * The benchmark prints the byte size of every rendered payload, so the numbers
 * can always be read against what was actually measured.
 */

import { EmailRenderer } from "@usesend/email-editor/src/renderer";
import { getDefaultDoubleOptInContent } from "~/lib/constants/double-opt-in";

/**
 * The editor document type, borrowed from the renderer rather than importing
 * `@tiptap/core` — that package is a dependency of `packages/email-editor`, not
 * of `apps/web`.
 */
export type EditorDocument = ConstructorParameters<typeof EmailRenderer>[0];

const LOREM = [
  "We shipped a handful of things this month that we think you will actually notice.",
  "The dashboard is faster, the API returns better errors, and scheduled sends no longer drift.",
  "Everything below is live today — no flag to flip, no migration to run.",
  "If any of it breaks for you, reply to this email and it lands in our inbox, not a queue.",
];

function paragraph(text: string, withLink: boolean) {
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: `${text} ` },
    {
      type: "text",
      marks: [{ type: "bold" }],
      text: "Worth a look",
    },
    { type: "text", text: " — " },
  ];

  if (withLink) {
    content.push({
      type: "text",
      marks: [
        {
          type: "link",
          attrs: {
            href: "https://usesend.com/blog/october-changelog?utm_source=newsletter",
            target: "_blank",
            rel: "noopener noreferrer nofollow",
          },
        },
      ],
      text: "read the changelog",
    });
  } else {
    content.push({
      type: "text",
      marks: [{ type: "italic" }],
      text: "details below",
    });
  }

  content.push({ type: "text", text: "." });

  return { type: "paragraph", attrs: { textAlign: "left" }, content };
}

function section(index: number) {
  return [
    {
      type: "heading",
      attrs: { textAlign: "left", level: 2 },
      content: [{ type: "text", text: `What changed — part ${index + 1}` }],
    },
    paragraph(LOREM[index % LOREM.length] as string, true),
    paragraph(LOREM[(index + 1) % LOREM.length] as string, false),
    {
      type: "bulletList",
      content: [0, 1, 2].map((item) => ({
        type: "listItem",
        content: [
          {
            type: "paragraph",
            attrs: { textAlign: "left" },
            content: [
              {
                type: "text",
                text: `Improvement ${index + 1}.${item + 1} — smaller payloads, fewer round trips.`,
              },
            ],
          },
        ],
      })),
    },
    {
      type: "image",
      attrs: {
        src: `https://cdn.usesend.com/newsletter/section-${index + 1}.png`,
        alt: `Screenshot for section ${index + 1}`,
        width: 600,
        height: 320,
        alignment: "center",
        externalLink: "https://usesend.com/changelog",
      },
    },
    {
      type: "button",
      attrs: {
        component: "button",
        text: "See what's new",
        url: "https://usesend.com/changelog?utm_source=newsletter",
        alignment: "left",
        borderRadius: "8",
        borderWidth: "1",
        buttonColor: "#000000",
        borderColor: "#000000",
        textColor: "#ffffff",
      },
    },
    {
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          attrs: { textAlign: "left" },
          content: [
            {
              type: "text",
              text: "It used to take us an afternoon. It now takes a command.",
            },
          ],
        },
      ],
    },
    { type: "horizontalRule" },
  ];
}

/**
 * A newsletter-shaped editor document of `sections` repeated sections, opened
 * with a personalised greeting and closed with an unsubscribe line — the two
 * places a campaign always puts variables.
 */
export function buildNewsletterDoc(sections: number): EditorDocument {
  const content: Array<Record<string, unknown>> = [
    {
      type: "heading",
      attrs: { textAlign: "left", level: 1 },
      content: [{ type: "text", text: "The useSend monthly" }],
    },
    {
      type: "paragraph",
      attrs: { textAlign: "left" },
      content: [
        { type: "text", text: "Hey " },
        {
          type: "variable",
          attrs: { id: "firstName", label: null, fallback: "there" },
        },
        {
          type: "text",
          text: ", here is everything from the last four weeks.",
        },
      ],
    },
  ];

  for (let index = 0; index < sections; index++) {
    content.push(...section(index));
  }

  content.push({
    type: "paragraph",
    attrs: { textAlign: "left" },
    content: [
      { type: "text", text: "You can " },
      {
        type: "text",
        marks: [
          {
            type: "link",
            attrs: {
              href: "{{usesend_unsubscribe_url}}",
              target: "_blank",
              rel: "noopener noreferrer nofollow",
            },
          },
        ],
        text: "unsubscribe",
      },
      { type: "text", text: " at any time." },
    ],
  });

  return { type: "doc", content } as EditorDocument;
}

/**
 * `DEFAULT_DOUBLE_OPT_IN_CONTENT` from `lib/constants/double-opt-in.ts`, the
 * only editor document checked into the repo.
 */
export function doubleOptInDoc(): EditorDocument {
  return getDefaultDoubleOptInContent() as EditorDocument;
}

/**
 * The variable and link values `renderCampaignHtmlForContact`
 * (`service/campaign-service.ts:133`) hands the renderer for each recipient.
 */
export const campaignRenderOptions = {
  shouldReplaceVariableValues: true,
  variableValues: {
    email: "casey@example.com",
    firstName: "Casey",
    lastName: "Alvarez",
    usesend_unsubscribe_url: "https://usesend.com/unsubscribe?id=c_01HQ8Z9",
    unsend_unsubscribe_url: "https://usesend.com/unsubscribe?id=c_01HQ8Z9",
  },
  linkValues: {
    "{{usesend_unsubscribe_url}}":
      "https://usesend.com/unsubscribe?id=c_01HQ8Z9",
  },
};

/**
 * A realistic SES event notification wrapped in its SNS envelope, shaped from
 * `types/aws-types.ts` (`SnsNotificationMessage` + `SesEvent`) and the header
 * set `buildHeaders` (`server/aws/ses.ts`) puts on every outbound message.
 * This is the exact string `POST /api/ses_callback` receives as its body.
 */
export function buildSnsEventBody(eventType: "Delivery" | "Open" | "Click") {
  const mail = {
    timestamp: "2026-09-17T09:14:22.123Z",
    source: "hello@mail.example.com",
    messageId: "0100019249ab1f2c-6b1d0f7a-4a8e-4c1f-9d3b-2f6a1c8e5d40-000000",
    destination: ["casey@example.com"],
    headersTruncated: false,
    headers: [
      { name: "From", value: "useSend <hello@mail.example.com>" },
      { name: "To", value: "casey@example.com" },
      { name: "Subject", value: "The useSend monthly — September" },
      {
        name: "MIME-Version",
        value: "1.0",
      },
      {
        name: "Content-Type",
        value:
          'multipart/alternative; boundary="--_NmP-1a2b3c4d5e6f7890-Part_1"',
      },
      { name: "X-Usesend-Email-ID", value: "clv9k2x4a0001qz3h8f7d2n5p" },
      { name: "X-Entity-Ref-ID", value: "clv9k2x4a0001qz3h8f7d2n5p" },
      {
        name: "List-Unsubscribe",
        value: "<https://usesend.com/unsubscribe?id=c_01HQ8Z9>",
      },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
      { name: "Precedence", value: "bulk" },
    ],
    commonHeaders: {
      from: ["useSend <hello@mail.example.com>"],
      to: ["casey@example.com"],
      messageId:
        "<0100019249ab1f2c-6b1d0f7a-4a8e-4c1f-9d3b-2f6a1c8e5d40-000000@eu-west-1.amazonses.com>",
      subject: "The useSend monthly — September",
    },
    tags: {
      "ses:operation": ["SendEmail"],
      "ses:configuration-set": ["usesend-click-open"],
      "ses:source-ip": ["52.94.133.131"],
      "ses:from-domain": ["mail.example.com"],
      "ses:caller-identity": ["usesend-sender"],
      "ses:outgoing-ip": ["23.251.234.12"],
    },
  };

  const event: Record<string, unknown> = { eventType, mail };

  if (eventType === "Delivery") {
    event.delivery = {
      timestamp: "2026-09-17T09:14:23.871Z",
      processingTimeMillis: 1748,
      recipients: ["casey@example.com"],
      smtpResponse: "250 2.0.0 OK  1758100463 d9443c01a7336-2093c3f2e1dsi",
      reportingMTA: "a8-93.smtp-out.eu-west-1.amazonses.com",
    };
  } else if (eventType === "Open") {
    event.open = {
      ipAddress: "66.249.84.201",
      timestamp: "2026-09-17T09:31:02.004Z",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    };
  } else {
    event.click = {
      ipAddress: "66.249.84.201",
      timestamp: "2026-09-17T09:31:44.917Z",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
      link: "https://usesend.com/changelog?utm_source=newsletter",
      linkTags: {},
    };
  }

  const envelope = {
    Type: "Notification",
    MessageId: "8f1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
    TopicArn: "arn:aws:sns:eu-west-1:123456789012:usesend-ses-events",
    Message: JSON.stringify(event),
    Timestamp: "2026-09-17T09:14:24.011Z",
    SignatureVersion: "1",
    Signature:
      "EXAMPLEw6JRN0uJ1lqDmYhQ1i0ImUfSsn1Eq0aVpqeNo6R7Sjx0k1BhcW3IYRKNHwBS5CPqkA0GukfzO3B6h9WjMeLoF6jY0Ol0mRT9Gnk4sHfNB0BqXbY8qQ0mT2JrZKcMv7xhEpQ0P1Uz3aRfTnGm2s0KcVbNqLwYxJdRtHgS4=",
    SigningCertURL:
      "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-9c6465fa7f48f5cacd23014631ec1136.pem",
    UnsubscribeURL:
      "https://sns.eu-west-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=arn:aws:sns:eu-west-1:123456789012:usesend-ses-events:3f0c4b4e-1d2a-4e6f-9a8b-7c6d5e4f3a2b",
  };

  return JSON.stringify(envelope);
}
