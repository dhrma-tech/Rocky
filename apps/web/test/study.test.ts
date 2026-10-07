import type { MindMap } from "@rocky/contracts";
import { describe, expect, it } from "vitest";
import { layoutMindMap, NODE_H, NODE_W } from "../src/mindmap-layout.ts";
import {
  cleanRules,
  daysLabel,
  daysUntil,
  hasRules,
  parseIds,
  parseList,
  ratingForKey,
  rulesSummary,
  slotLabel,
  weaknessWord,
} from "../src/study.ts";

describe("study helpers", () => {
  it("counts calendar days, not 24 h blocks", () => {
    const now = new Date(2026, 9, 7, 23, 30).getTime();
    expect(daysUntil(new Date(2026, 9, 8, 0, 15).getTime(), now)).toBe(1);
    expect(daysUntil(new Date(2026, 9, 7, 8, 0).getTime(), now)).toBe(0);
    expect(daysUntil(new Date(2026, 9, 21, 9, 0).getTime(), now)).toBe(14);
    expect(daysUntil(new Date(2026, 9, 5, 9, 0).getTime(), now)).toBe(-2);
    expect([0, 1, -1, 5, -3].map(daysLabel)).toEqual([
      "today",
      "tomorrow",
      "yesterday",
      "in 5 days",
      "3 days ago",
    ]);
  });

  it("parses comma lists, dropping blanks, duplicates and 1-letter entries", () => {
    expect(parseList("CS201, Data Structures ,, x, CS201\nMATH 2")).toEqual([
      "CS201",
      "Data Structures",
      "MATH 2",
    ]);
  });

  it("extracts Drive folder ids from links", () => {
    expect(
      parseIds(
        "https://drive.google.com/drive/folders/1AbC_d-EF?usp=sharing\nhttps://drive.google.com/open?id=XYZ123 rawId",
        "drive",
      ),
    ).toEqual(["1AbC_d-EF", "XYZ123", "rawId"]);
  });

  it("extracts Notion page ids from links, as dashed UUIDs", () => {
    const id = "1a2b3c4d5e6f40718293a4b5c6d7e8f9";
    const dashed = "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9";
    expect(parseIds(`https://www.notion.so/team/Cafe-Lecture-Notes-${id}?pvs=4`, "notion")).toEqual(
      [dashed],
    );
    expect(parseIds(dashed, "notion")).toEqual([dashed]);
  });

  it("cleans rules so an untouched editor saves nothing", () => {
    expect(cleanRules({ titleMatches: [], driveFolderIds: [], sourceTypes: [] })).toEqual({});
    expect(hasRules({ titleMatches: [] })).toBe(false);
    expect(cleanRules({ titleMatches: ["CS201"], dateFrom: 0 })).toEqual({
      titleMatches: ["CS201"],
      dateFrom: 0,
    });
    expect(rulesSummary({ titleMatches: ["CS201"], driveFolderIds: ["a", "b"] })).toEqual([
      "Titles containing CS201",
      "2 Drive folders",
    ]);
  });

  it("labels slots, ratings and weakness", () => {
    expect(slotLabel({ day: 1, start: "09:00", end: "10:30" })).toBe("Mon 09:00–10:30");
    expect(["1", "2", "3", "4", "5", " "].map(ratingForKey)).toEqual([
      "again",
      "hard",
      "good",
      "easy",
      null,
      null,
    ]);
    expect([0.9, 0.5, 0.1].map(weaknessWord)).toEqual(["weak", "shaky", "solid"]);
  });

  it("lays out the mind map left to right and drops bad edges", () => {
    const map: MindMap = {
      nodes: [
        { id: "a", label: "Sorting", citations: [] },
        { id: "b", label: "Quicksort", citations: [] },
        { id: "c", label: "Merge sort", citations: [] },
      ],
      edges: [
        { from: "a", to: "b", label: "example" },
        { from: "a", to: "c", label: null },
        { from: "a", to: "zz", label: null },
        { from: "b", to: "b", label: null },
      ],
    };
    const { nodes, edges } = layoutMindMap(map);
    expect(edges.map((e) => [e.from, e.to])).toEqual([
      ["a", "b"],
      ["a", "c"],
    ]);
    const at = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(at.b?.x).toBeGreaterThan((at.a?.x ?? 0) + NODE_W);
    expect(at.b?.x).toBe(at.c?.x);
    expect(Math.abs((at.b?.y ?? 0) - (at.c?.y ?? 0))).toBeGreaterThanOrEqual(NODE_H);
  });
});
