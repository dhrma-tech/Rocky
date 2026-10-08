import { useEffect, useState } from "react";
import type { Meta, Story } from "../stories/catalog.ts";
import {
  Banner,
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  Skeleton,
  Switch,
  Tabs,
  Textarea,
  ToastProvider,
  useToast,
} from "./index.tsx";

export default { title: "Base" } satisfies Meta;

const stack = { display: "grid", gap: "var(--space-4)", maxWidth: 560 } as const;

export const CardDefault: Story = () => (
  <div style={stack}>
    <Card>
      <h3 className="rk-h3">Weekly brief</h3>
      <p className="rk-small rk-muted">Every Monday at 8:00</p>
    </Card>
    <Card tint>
      <h3 className="rk-h3">Needs you</h3>
      <p className="rk-small">A tinted card is about the user.</p>
    </Card>
  </div>
);

export const Banners: Story = () => (
  <div style={stack}>
    <Banner tone="info" title="Live updates are back." onDismiss={() => {}} />
    <Banner tone="success" title="Exported 12 events." />
    <Banner
      tone="warning"
      title="Needs you to sign in again."
      actions={<Button variant="primary">Reconnect</Button>}
    >
      GitHub rejected the stored token.
    </Banner>
    <Banner
      tone="error"
      title="Rocky's engine isn't responding."
      actions={
        <>
          <Button variant="primary">Restart</Button>
          <Button>View log</Button>
        </>
      }
    >
      Last seen 2 minutes ago. What is below is read-only until it is back.
    </Banner>
  </div>
);

export const Empty: Story = () => (
  <EmptyState headline="Nothing is waiting." action={<Button>Open the ledger</Button>}>
    Approvals appear here when Rocky drafts something that changes one of your apps.
  </EmptyState>
);

export const ErrorPattern: Story = () => (
  <ErrorState
    title="This step failed."
    happened="GitHub answered with an error when Rocky created the issue."
    rockyDid="Rocky tried once and kept the approved payload, so nothing was lost."
    fix={<Button variant="primary">Retry this step</Button>}
    details={{ code: "HTTP_502", log: "HTTP 502 from api.github.com/repos/o/r/issues" }}
  />
);

export const Loading: Story = () => <Skeleton rows={4} height={52} label="Loading approvals" />;

export const Fields: Story = () => (
  <div style={stack}>
    <Input label="Repository" placeholder="owner/name" help="The repo the issue goes to." />
    <Input label="Recipient domain" defaultValue="acme" error="Use a full domain, like acme.dev." />
    <Input label="Disabled field" defaultValue="Read only" disabled />
    <Textarea label="Goal" help="What should Rocky do?" />
  </div>
);
Fields.parameters = { states: ["focus"] };

export const Switches: Story = () => {
  const [on, setOn] = useState(true);
  return (
    <div style={stack}>
      <Switch label="Follow live" checked={on} onChange={setOn} />
      <Switch label="Show raw payloads" checked={false} onChange={() => {}} />
      <Switch label="Unavailable setting" checked={false} disabled onChange={() => {}} />
    </div>
  );
};
Switches.parameters = { states: ["focus"] };

export const TabSet: Story = () => {
  const [tab, setTab] = useState("activity");
  return (
    <Tabs
      label="Work pane"
      value={tab}
      onChange={setTab}
      tabs={[
        { id: "activity", title: "Activity", panel: <p>Activity panel</p> },
        { id: "files", title: "Files", panel: <p>Files panel</p> },
        { id: "memory", title: "Memory", panel: <p>Memory panel</p> },
      ]}
    />
  );
};
TabSet.parameters = { states: ["focus"] };

export const DrawerOpen: Story = () => {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open payload</Button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Payload">
        <pre className="rk-mono">
          {JSON.stringify({ repo: "o/r", title: "Fix login" }, null, 2)}
        </pre>
      </Drawer>
    </>
  );
};

function ToastDemo() {
  const toast = useToast();
  useEffect(() => {
    toast({ text: "Approved. Runs in 10 seconds.", action: { label: "Undo", run: () => {} } });
  }, [toast]);
  return <p className="rk-muted">A toast with Undo appears bottom left.</p>;
}

export const Toast: Story = () => (
  <ToastProvider>
    <ToastDemo />
  </ToastProvider>
);
