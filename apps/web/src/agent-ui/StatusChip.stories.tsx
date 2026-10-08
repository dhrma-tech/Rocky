import type { Meta, Story } from "../stories/catalog.ts";
import { Pebble } from "./Pebble.tsx";
import { StatusChip } from "./StatusChip.tsx";
import { AGENT_STATES, STATUS } from "./status.ts";

export default { title: "Agent/Status (eleven states)" } satisfies Meta;

/** Every state: pebble and chip render from the same value, so they always agree. */
export const AllStates: Story = () => (
  <table style={{ borderCollapse: "separate", borderSpacing: "var(--space-4) var(--space-3)" }}>
    <thead>
      <tr>
        <th scope="col" style={{ textAlign: "left" }}>
          State
        </th>
        <th scope="col">Pebble</th>
        <th scope="col" style={{ textAlign: "left" }}>
          Chip
        </th>
      </tr>
    </thead>
    <tbody>
      {AGENT_STATES.map((s) => (
        <tr key={s}>
          <td>
            <code>{s}</code>
          </td>
          <td style={{ textAlign: "center" }}>
            <Pebble state={s} size={32} />
          </td>
          <td>
            <StatusChip
              state={s}
              detail={{
                step: { n: 3, of: 7 },
                host: "example.com",
                memory: "Dana's preferences",
              }}
            />
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);
AllStates.storyName = "All eleven states";

export const PebbleSizes: Story = () => (
  <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "end" }}>
    {([20, 24, 32, 40, 64] as const).map((size) => (
      <Pebble key={size} size={size} state="completed" label={`Rocky, ${STATUS.completed.word}`} />
    ))}
  </div>
);

export const IdentitySwatches: Story = () => (
  <div style={{ display: "flex", gap: "var(--space-4)" }}>
    {(["periwinkle", "rose", "sage", "butter", "lilac", "peach"] as const).map((swatch) => (
      <Pebble key={swatch} size={40} swatch={swatch} label={`Rocky in ${swatch}`} />
    ))}
  </div>
);
