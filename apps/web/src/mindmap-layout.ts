import dagre from "@dagrejs/dagre";
import type { MindMap } from "@rocky/contracts";

/** Mind map layout, separate from study.ts so dagre loads only with the lazy mind map chunk. */

export const NODE_W = 180;
export const NODE_H = 44;

export interface PlacedNode {
  id: string;
  label: string;
  x: number;
  y: number;
}

/**
 * Top-left positions for the mind map, from dagre (left to right). Edges to unknown nodes and
 * self-loops are dropped; the model's output was validated by the daemon but the layout stays defensive.
 */
export function layoutMindMap(map: MindMap): {
  nodes: PlacedNode[];
  edges: { id: string; from: string; to: string; label: string | null }[];
} {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 64 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(map.nodes.map((n) => n.id));
  for (const n of map.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  const edges = map.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
    .map((e, i) => ({ id: `e${i}`, from: e.from, to: e.to, label: e.label }));
  for (const e of edges) g.setEdge(e.from, e.to);
  dagre.layout(g);
  const nodes = map.nodes.map((n) => {
    const p = g.node(n.id) as { x: number; y: number };
    return { id: n.id, label: n.label, x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 };
  });
  return { nodes, edges };
}
