import type { Citation, MindMap } from "@rocky/contracts";
import { Background, Controls, type Edge, type Node, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";
import { layoutMindMap, NODE_H, NODE_W } from "../mindmap-layout.ts";
import { Citations } from "./study.tsx";

/**
 * Mind map (notebooks.md): @xyflow/react with dagre layout. Read-only; clicking a node lists its
 * citations. Loaded lazily, since xyflow only matters on this tab. Colors come from the
 * `.rocky-flow` token overrides in app.css.
 */
export default function MindMapView({
  map,
  onOpen,
}: {
  map: MindMap;
  onOpen: (c: Citation) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const { nodes, edges } = useMemo(() => {
    const placed = layoutMindMap(map);
    const nodes: Node[] = placed.nodes.map((n) => ({
      id: n.id,
      position: { x: n.x, y: n.y },
      data: { label: n.label },
      style: { width: NODE_W, height: NODE_H },
      connectable: false,
      draggable: false,
      ariaLabel: n.label,
    }));
    const edges: Edge[] = placed.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      ...(e.label ? { label: e.label } : {}),
    }));
    return { nodes, edges };
  }, [map]);
  const node = map.nodes.find((n) => n.id === selected);

  return (
    <div className="flex flex-col gap-3">
      <div className="rocky-flow h-[520px] overflow-hidden rounded-lg bg-raised shadow-raised-sm">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          nodesConnectable={false}
          nodesDraggable={false}
          elementsSelectable
          onNodeClick={(_, n) => setSelected(n.id)}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div aria-live="polite" className="min-h-10 text-sm">
        {node ? (
          <p>
            <span className="font-medium">{node.label}</span>{" "}
            <Citations citations={node.citations} onOpen={onOpen} />
          </p>
        ) : (
          <p className="text-secondary">Select a concept to see where it comes from.</p>
        )}
      </div>
    </div>
  );
}
