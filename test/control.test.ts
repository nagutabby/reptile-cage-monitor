import { describe, expect, it } from "vitest";
import { currentTemperature, scheduledEpochMs, temperatureFromRetainedMessage } from "../lambda/shadow-control";

describe("device control rules", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");

  it("uses retained temperatures only while they are at most three minutes old", () => {
    expect(currentTemperature({ temp_c: 31.9, observed_at: new Date(now - 180_000).toISOString() }, now)).toBe(31.9);
    expect(currentTemperature({ temp_c: 31.9, observed_at: new Date(now - 180_001).toISOString() }, now)).toBeNull();
    expect(currentTemperature({ temp_c: 32, observed_at: new Date(now + 1).toISOString() }, now)).toBeNull();
    expect(temperatureFromRetainedMessage({
      payload: Buffer.from(JSON.stringify({ temp_c: 32, observed_at: new Date(now).toISOString() })),
      lastModifiedTime: new Date(now),
    }, now)).toBe(32);
    expect(temperatureFromRetainedMessage({
      payload: Buffer.from(JSON.stringify({ temp_c: 32, observed_at: new Date(now).toISOString() })),
      lastModifiedTime: now,
    }, now)).toBe(32);
    expect(temperatureFromRetainedMessage({
      payload: Buffer.from(JSON.stringify({ temp_c: 32, observed_at: new Date(now).toISOString() })),
      lastModifiedTime: now + 1,
    }, now)).toBeNull();
  });

  it("computes schedule instants at Japan local 07:00 and 19:00", () => {
    const now = new Date("2026-09-30T00:15:00Z");
    expect(new Date(scheduledEpochMs(now, 7)).toISOString()).toBe("2026-09-29T22:00:00.000Z");
    expect(new Date(scheduledEpochMs(now, 19)).toISOString()).toBe("2026-09-30T10:00:00.000Z");
  });
});
