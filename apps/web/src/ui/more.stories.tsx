import { useState } from "react";
import type { Meta, Story } from "../stories/catalog.ts";
import {
  Avatar,
  Button,
  Checkbox,
  Modal,
  Progress,
  RadioGroup,
  Segmented,
  Select,
  Table,
} from "./index.tsx";

export default { title: "Base/More" } satisfies Meta;

export const Choices: Story = () => {
  const [theme, setTheme] = useState("system");
  const [preset, setPreset] = useState<"ask-all" | "ask-risky" | "read-only">("ask-risky");
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState<"light" | "dark" | "system">("system");
  return (
    <div style={{ display: "grid", gap: "var(--space-4)", maxWidth: 480 }}>
      <Select
        label="Theme"
        value={theme}
        onChange={setTheme}
        options={[
          { value: "system", label: "Follow the system" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />
      <RadioGroup
        legend="What Rocky may do"
        value={preset}
        onChange={setPreset}
        options={[
          { value: "ask-all", label: "Ask about everything" },
          {
            value: "ask-risky",
            label: "Ask about risky things",
            help: "Reads freely; asks before it changes anything.",
          },
          { value: "read-only", label: "Read only" },
        ]}
      />
      <Checkbox label="Show raw payloads" checked={on} onChange={setOn} />
      <Segmented
        label="Appearance"
        value={seg}
        onChange={setSeg}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "system", label: "System" },
        ]}
      />
    </div>
  );
};
Choices.parameters = { states: ["focus"] };

const ROWS = [
  { id: "1", title: "Monday plan", status: "Done", duration: 104 },
  { id: "2", title: "Sync Gmail", status: "Done", duration: 12 },
  { id: "3", title: "Transcribe lecture 4", status: "Failed", duration: 340 },
];
export const SortableTable: Story = () => (
  <Table
    caption="Task history"
    rowKey={(r) => r.id}
    rows={ROWS}
    initialSort={{ key: "duration", dir: "desc" }}
    columns={[
      { key: "title", title: "Title", render: (r) => r.title, sort: (r) => r.title },
      { key: "status", title: "Status", render: (r) => r.status },
      {
        key: "duration",
        title: "Duration",
        render: (r) => `${r.duration} s`,
        sort: (r) => r.duration,
      },
    ]}
  />
);
SortableTable.parameters = { states: ["focus"] };

export const ConfirmModal: Story = () => {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Archive project</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Archive Launch?"
        actions={
          <>
            <Button variant="tertiary" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => setOpen(false)}>
              Archive
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>Its history stays in the ledger. You can bring it back later.</p>
      </Modal>
    </>
  );
};

export const ProgressAndAvatars: Story = () => (
  <div style={{ display: "grid", gap: "var(--space-4)", maxWidth: 360 }}>
    <Progress label="Transcribing" n={3} of={7} />
    <Progress label="Waiting for Ollama" n={0} />
    <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "end" }}>
      {([20, 24, 32, 40, 64] as const).map((s) => (
        <Avatar key={s} name="Sam Okafor" size={s} />
      ))}
    </div>
  </div>
);
