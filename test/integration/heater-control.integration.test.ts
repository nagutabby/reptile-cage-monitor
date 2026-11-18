import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emulatorHost, readDesired, resetShadow, setRetainedTelemetry, writeDesired } from "./helpers";

type Heater = typeof import("../../lambda/heater-control");
let heater: Heater;

const telemetry = (tempC: number, ageMs = 0) => ({
  temp_c: tempC,
  observed_at: new Date(Date.now() - ageMs).toISOString(),
});

beforeAll(async () => {
  process.env.IOT_ENDPOINT = emulatorHost();
  heater = await import("../../lambda/heater-control");
});

beforeEach(async () => {
  await resetShadow();
  await setRetainedTelemetry(null);
});

describe("heater control against AWS Emulator", () => {
  it("keeps the heater on below the 32C limit", async () => {
    await setRetainedTelemetry(telemetry(31.9));

    expect(await heater.handler()).toEqual({ status: "updated", temperature_available: true });
    expect(await readDesired()).toMatchObject({ is_heater_on: true });
  });

  it("turns the heater off at the 32C limit", async () => {
    await setRetainedTelemetry(telemetry(32));

    expect(await heater.handler()).toEqual({ status: "updated", temperature_available: true });
    expect(await readDesired()).toMatchObject({ is_heater_on: false });
  });

  it("fails safe by keeping the heater on when no telemetry has been retained", async () => {
    expect(await heater.handler()).toEqual({ status: "updated", temperature_available: false });
    expect(await readDesired()).toMatchObject({ is_heater_on: true });
  });

  it("does not trust a reading older than three minutes, even at a high temperature", async () => {
    await setRetainedTelemetry(telemetry(35, 181_000));

    expect(await heater.handler()).toEqual({ status: "updated", temperature_available: false });
    expect(await readDesired()).toMatchObject({ is_heater_on: true });
  });

  it("switches the heater off after it was on when the cage gets hot", async () => {
    await setRetainedTelemetry(telemetry(30));
    await heater.handler();
    await setRetainedTelemetry(telemetry(33));

    expect(await heater.handler()).toEqual({ status: "updated", temperature_available: true });
    expect(await readDesired()).toMatchObject({ is_heater_on: false });
  });

  it("reports unchanged when the desired state already matches", async () => {
    await setRetainedTelemetry(telemetry(30));
    await heater.handler();

    expect(await heater.handler()).toEqual({ status: "unchanged", temperature_available: true });
  });

  it("seeds the light state from the Japan-time schedule on the first run only", async () => {
    await setRetainedTelemetry(telemetry(30));
    const before = Date.now();
    await heater.handler();

    const jstHour = (new Date(before).getUTCHours() + 9) % 24;
    const seeded = await readDesired();
    expect(seeded.is_light_on).toBe(jstHour >= 7 && jstHour < 19);
    expect(seeded.light_command_at).toBeLessThanOrEqual(Date.now());
    expect(seeded.light_command_at as number).toBeGreaterThan(before - 24 * 60 * 60_000);

    // 既に照明状態がある場合は上書きしない
    await writeDesired({ is_light_on: !seeded.is_light_on, light_command_at: 1 });
    await heater.handler();
    expect(await readDesired()).toMatchObject({ is_light_on: !seeded.is_light_on, light_command_at: 1 });
  });
});
