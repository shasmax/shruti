import { describe, it, expect } from "vitest";
import { resolveDueDate } from "../src/dates.js";

// 2026-04-30 is a Thursday (UTC).
const BASE = "2026-04-30T14:00:00Z";

describe("resolveDueDate", () => {
  it("resolves 'by Friday' to next Friday", () => {
    expect(resolveDueDate("I'll send it by Friday", BASE)).toBe("2026-05-01");
  });

  it("resolves 'by Monday' to next Monday", () => {
    expect(resolveDueDate("done by Monday", BASE)).toBe("2026-05-04");
  });

  it("resolves 'by next week' to +7 days", () => {
    expect(resolveDueDate("ship by next week", BASE)).toBe("2026-05-07");
  });

  it("resolves 'by end of week' to next Friday", () => {
    expect(resolveDueDate("by end of week", BASE)).toBe("2026-05-01");
  });

  it("resolves 'by end of day' to base date", () => {
    expect(resolveDueDate("by end of day", BASE)).toBe("2026-04-30");
  });

  it("returns undefined when no phrase matches", () => {
    expect(resolveDueDate("we're moving fast", BASE)).toBeUndefined();
  });

  it("returns undefined without a base date", () => {
    expect(resolveDueDate("by Friday", undefined)).toBeUndefined();
  });

  it("returns undefined for invalid base", () => {
    expect(resolveDueDate("by Friday", "not-a-date")).toBeUndefined();
  });
});
