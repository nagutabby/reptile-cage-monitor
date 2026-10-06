import { describe, expect, it } from "vitest";
import { parseCapturedPresetEvent } from "../lambda/air-conditioner-presets";

const captured = {
  status: "captured",
  preset_id: 1,
  name: "Night",
  revision: 3,
  reported_at: 1_797_000_000,
  preset: { mode: "cool", temp_c: 27, fan: "auto", swing_v: "off" },
};

describe("air-conditioner preset capture events", () => {
  it("accepts only captured events for one of the four slots", () => {
    expect(parseCapturedPresetEvent(captured)?.preset_id).toBe(1);
    expect(parseCapturedPresetEvent({ ...captured, preset_id: 5 })).toBeNull();
    expect(parseCapturedPresetEvent({ ...captured, status: "sent" })).toBeNull();
  });
});
