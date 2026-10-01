import { describe, expect, it } from "vitest";
import { isAbnormal, shouldNotify } from "../lambda/ingest";

describe("LINE environment alerts", () => {
  it("keeps the configured temperature and humidity limits inclusive", () => {
    expect(isAbnormal({ temp_c: 24, humidity: 40 })).toBe(false);
    expect(isAbnormal({ temp_c: 32, humidity: 90 })).toBe(false);
    expect(isAbnormal({ temp_c: 23.9, humidity: 60 })).toBe(true);
    expect(isAbnormal({ temp_c: 30, humidity: 90.1 })).toBe(true);
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
