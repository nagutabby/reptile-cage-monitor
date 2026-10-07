import { describe, expect, it } from "vitest";
import { isAbnormal, parseTelemetry, shouldNotify } from "../lambda/ingest";

describe("LINE environment alerts", () => {
  it("keeps the configured temperature and humidity limits inclusive", () => {
    expect(isAbnormal({ temp_c: 24, humidity: 40 })).toBe(false);
    expect(isAbnormal({ temp_c: 32, humidity: 90 })).toBe(false);
    expect(isAbnormal({ temp_c: 23.9, humidity: 60 })).toBe(true);
    expect(isAbnormal({ temp_c: 30, humidity: 90.1 })).toBe(true);
  });

  it("ignores fields that were not reported", () => {
    expect(isAbnormal({ humidity: 60 })).toBe(false);
    expect(isAbnormal({ temp_c: 23.9 })).toBe(true);
    expect(isAbnormal({})).toBe(false);
  });

  it("accepts telemetry with any subset of the readings but not an empty one", () => {
    const base = { event_id: "sensor-1", observed_at: "2026-10-07T00:00:00Z" };
    expect(parseTelemetry({ ...base, battery: 80 })).toMatchObject({ battery: 80 });
    expect(parseTelemetry({ ...base, temp_c: 27, humidity: 50 })).toMatchObject({ temp_c: 27, humidity: 50 });
    expect(parseTelemetry(base)).toBeNull();
    expect(parseTelemetry({ ...base, temp_c: "27" })).toBeNull();
  });

  it("notifies on an abnormal transition and every hour while it continues", () => {
    const lastAlertAt = 1_000_000;
    const previous = { is_abnormal: true, last_alert_at: lastAlertAt };

    expect(shouldNotify(true, undefined, lastAlertAt)).toBe(true);
    expect(shouldNotify(true, { ...previous, is_abnormal: false }, lastAlertAt + 1)).toBe(true);
    expect(shouldNotify(true, previous, lastAlertAt + 3_599_999)).toBe(false);
    expect(shouldNotify(true, previous, lastAlertAt + 3_600_000)).toBe(true);
    expect(shouldNotify(false, previous, lastAlertAt + 3_600_000)).toBe(false);
  });
});
