import type { ActionRecord } from "@rocky/contracts";
import { useEffect, useRef } from "react";
import type { Meta, Story } from "../stories/catalog.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";

export default { title: "Agent/Approval card" } satisfies Meta;

const NOW = Date.UTC(2026, 9, 8, 9, 0);
const noop = () => {};
const base: ActionRecord = {
  id: "01JAPPROVAL0000000000000000",
  type: "github.issueCreate",
  title: "Create GitHub issue",
  connectorId: "github",
  payload: {
    repo: "acme/web",
    title: "Fix Safari login loop",
    body: "Users on Safari 17 get sent back to the login page after signing in.",
  },
  payloadHash: "9f2c4b1e7a0d3c5f8e6b2a4d1c9e7f3a5b8d0c2e4f6a8b1d3c5e7f9a0b2c4d6e",
  risk: "medium",
  status: "draft",
  origin: "user_turn",
  citations: [
    {
      chunkId: "c1",
      documentId: "d1",
      title: "Standup, 7 Oct",
      anchor: { kind: "text" },
      quote: "Ana will open a ticket for the Safari login loop",
    },
  ],
  suspicious: false,
  provenance: [],
  review: "standard",
  actionClass: "write",
  description: { target: "acme/web", summary: "Fix Safari login loop" },
  idempotencyKey: "k",
  approvedAt: null,
  approvedBy: null,
  executeAfter: null,
  result: null,
  error: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const card = (
  a: Partial<ActionRecord>,
  extra: Partial<Parameters<typeof ApprovalCard>[0]> = {},
) => (
  <div style={{ maxWidth: 640 }}>
    <ApprovalCard
      action={{ ...base, ...a }}
      now={NOW}
      onApprove={noop}
      onEdit={noop}
      onDeny={noop}
      onUndo={noop}
      onRunNow={noop}
      onAlwaysAllow={noop}
      {...extra}
    />
  </div>
);

export const Draft: Story = () => card({});
Draft.parameters = { states: ["hover", "focus"] };

export const EmailFromExternalSource: Story = () =>
  card({
    type: "gmail.draftCreate",
    title: "Create Gmail draft",
    connectorId: "gmail",
    risk: "low",
    payload: {
      threadId: "t1",
      to: ["dana@acme.dev"],
      cc: [],
      subject: "Re: annual plan",
      body: "Hi Dana,\n\nThanks, annual works for us.\n\nSam",
    },
    description: { target: "dana@acme.dev", summary: "Re: annual plan" },
    review: "strict",
    provenance: [
      {
        documentId: "m1",
        title: "Re: annual plan",
        sourceType: "email",
        connectorId: "gmail",
        external: true,
        flags: [],
      },
    ],
    citations: [
      {
        ...base.citations[0],
        documentId: "m1",
        title: "Re: annual plan",
        quote: "Can you confirm annual billing?",
      },
    ] as ActionRecord["citations"],
  });
EmailFromExternalSource.storyName = "Email from an external source (strict review)";

function ConfirmStep() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(".rk-button--primary")?.click();
  }, []);
  return (
    <div ref={ref}>
      {card({
        type: "gcal.eventCreate",
        title: "Create calendar event",
        connectorId: "gcal",
        risk: "high",
        actionClass: "send",
        payload: {
          calendarId: "primary",
          summary: "Pricing review",
          start: { dateTime: "2026-10-09T14:00:00+02:00" },
          end: { dateTime: "2026-10-09T14:30:00+02:00" },
          attendees: ["dana@acme.dev", "ana@acme.dev"],
          notifyAttendees: true,
        },
        description: {
          target: "primary",
          summary: "New event with 2 guests (invitations are sent)",
        },
      })}
    </div>
  );
}
export const HighRiskConfirm: Story = () => <ConfirmStep />;
HighRiskConfirm.storyName = "High risk: deliberate second step";

export const HeldForUndo: Story = () =>
  card({
    status: "approved",
    approvedAt: NOW,
    approvedBy: { kind: "user" },
    executeAfter: NOW + 7_000,
  });
HeldForUndo.storyName = "Approved, held 10 s for Undo";

export const ApprovedByRule: Story = () =>
  card({
    status: "approved",
    approvedAt: NOW,
    approvedBy: { kind: "rule", ruleId: "r1" },
    executeAfter: NOW + 9_000,
  });

export const Failed: Story = () =>
  card({ status: "failed", error: "HTTP 502 from api.github.com/repos/acme/web/issues" });

export const Denied: Story = () => card({ status: "rejected" });

export const AnswerError: Story = () =>
  card({}, { answerError: "The daemon didn't answer. Your choice wasn't saved.", onRetry: noop });
AnswerError.storyName = "Couldn't send your answer";
