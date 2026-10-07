import { describe, expect, it } from "vitest";
import { fromCron, scheduleLabel, toCron } from "../src/routines.ts";

describe("schedule editor", () => {
  it("round-trips time and weekdays through cron", () => {
    expect(toCron({ time: "07:00", days: [1, 2, 3, 4, 5] })).toBe("0 7 * * 1-5");
    expect(toCron({ time: "21:30", days: [0, 6] })).toBe("30 21 * * 0,6");
    expect(toCron({ time: "09:05", days: [1, 3, 4, 5] })).toBe("5 9 * * 1,3-5");
    expect(toCron({ time: "08:00", days: [] })).toBe("0 8 * * *");
    for (const e of ["0 7 * * 1-5", "30 21 * * 0,6", "5 9 * * 1,3-5"])
      expect(toCron(fromCron(e) ?? { time: "", days: [] })).toBe(e);
  });

  it("reads the shipped schedules and refuses what the simple editor can't show", () => {
    expect(fromCron("0 18 * * 0")).toEqual({ time: "18:00", days: [0] });
    expect(fromCron("0 9 * * 7")).toEqual({ time: "09:00", days: [0] });
    expect(fromCron("*/15 * * * *")).toBeNull();
    expect(fromCron("0 9 1 * *")).toBeNull();
    expect(fromCron("nope")).toBeNull();
  });

  it("labels schedules for the list", () => {
    expect(scheduleLabel("0 7 * * 1-5")).toBe("Weekdays at 07:00");
    expect(scheduleLabel("0 16 * * 5")).toBe("Fri at 16:00");
    expect(scheduleLabel("30 8 * * *")).toBe("Every day at 08:30");
    expect(scheduleLabel("*/5 * * * *")).toBe("*/5 * * * *");
  });
});
