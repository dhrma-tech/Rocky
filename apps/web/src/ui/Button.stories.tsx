import { Check, Settings, Trash2 } from "lucide-react";
import type { Meta, Story } from "../stories/catalog.ts";
import { Button, IconButton } from "./Button.tsx";

export default { title: "Controls/Button" } satisfies Meta;

const row = {
  display: "flex",
  gap: "var(--space-3)",
  flexWrap: "wrap",
  alignItems: "center",
} as const;

export const Primary: Story = () => <Button variant="primary">Approve</Button>;
Primary.parameters = { states: ["hover", "focus"] };

export const Secondary: Story = () => <Button>Edit, then approve</Button>;
Secondary.parameters = { states: ["hover", "focus"] };

export const Tertiary: Story = () => <Button variant="tertiary">Deny</Button>;
Tertiary.parameters = { states: ["hover", "focus"] };

export const Danger: Story = () => (
  <Button variant="danger" icon={<Trash2 size={20} strokeWidth={1.5} aria-hidden />}>
    Delete everything
  </Button>
);
Danger.parameters = { states: ["hover", "focus"] };

export const Disabled: Story = () => (
  <div style={row}>
    <Button variant="primary" disabled>
      Approve
    </Button>
    <Button disabled>Edit</Button>
  </div>
);

export const Loading: Story = () => (
  <Button variant="primary" loading="Opening…">
    Open Rocky
  </Button>
);

export const Dense: Story = () => (
  <div style={row}>
    <Button dense icon={<Check size={16} strokeWidth={1.5} aria-hidden />}>
      Re-run
    </Button>
    <IconButton dense label="Settings for this row">
      <Settings size={16} strokeWidth={1.5} aria-hidden />
    </IconButton>
  </div>
);

export const IconOnly: Story = () => (
  <IconButton label="Settings">
    <Settings size={20} strokeWidth={1.5} aria-hidden />
  </IconButton>
);
IconOnly.parameters = { states: ["hover", "focus"] };
