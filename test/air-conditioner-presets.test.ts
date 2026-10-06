import { describe, expect, it } from "vitest";
import { parseCapturedPresetEvent } from "../lambda/air-conditioner-presets";

const captured = {
  status: "captured",
  preset_id: 1,
  name: "Night",
  revision: 3,
  reported_at: 1_797_000_000,
  preset: { mode: "cool", temp_c: 27, fan: "auto", swing_v: "off" },
  raw_data: [9000, 4500, 560, 560],
};

describe("air-conditioner preset capture events", () => {
  it("accepts only captured events for one of the four slots", () => {
    expect(parseCapturedPresetEvent(captured)?.preset_id).toBe(1);
    expect(parseCapturedPresetEvent({ ...captured, preset_id: 5 })).toBeNull();
    expect(parseCapturedPresetEvent({ ...captured, status: "sent" })).toBeNull();
  });

  it("accepts up to 700 valid timings and rejects larger or invalid data", () => {
    expect(parseCapturedPresetEvent({ ...captured, raw_data: Array(700).fill(900) })?.raw_data).toHaveLength(700);
    expect(parseCapturedPresetEvent({ ...captured, raw_data: Array(701).fill(900) })).toBeNull();
    expect(parseCapturedPresetEvent({ ...captured, raw_data: [900, 0] })).toBeNull();
  });
});
