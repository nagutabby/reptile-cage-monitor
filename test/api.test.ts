import { describe, expect, it, vi } from "vitest";
import { createApi, type AirConditionerSettings } from "../lambda/api";

const airConditionerSettings: AirConditionerSettings = { power: true, mode: "cool", temp_c: 27, fan: "auto", swing_v: "off" };

function testApi() {
  const dependencies = {
    listReadings: vi.fn(async () => [{ id: 1, temp_c: 27.2, humidity: 52, recorded_at: "2026-09-30T00:00:00+00:00" }]),
    getDeviceState: vi.fn(async () => ({
      is_light_on: false,
      is_light_on_changed_at: "2026-09-30T00:00:00+00:00",
      is_heater_on: true,
      is_heater_on_changed_at: "2026-09-30T00:00:00+00:00",
    })),
    setAirConditioner: vi.fn(async (_settings: AirConditionerSettings) => ({
      status: "queued" as const,
      command_id: "command-123",
    })),
    getPublicConfig: vi.fn(() => ({
      region: "ap-northeast-1",
      endpoint: "example.iot.ap-northeast-1.amazonaws.com",
      identityPoolId: "ap-northeast-1:identity-pool",
      userPoolId: "ap-northeast-1_user-pool",
      clientId: "public-client",
      cognitoDomain: "login.example.com",
    })),
  };
  return { app: createApi(dependencies), dependencies };
}

describe("Hono API", () => {
  it("serves public configuration and health checks", async () => {
    const { app } = testApi();
    const config = await app.request("/api/config");
    expect(config.status).toBe(200);
    expect(config.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await config.json()).toMatchObject({ region: "ap-northeast-1" });
    expect((await app.request("/healthz")).status).toBe(200);
  });

  it("lists readings with the default period and validates the requested period", async () => {
    const { app, dependencies } = testApi();
    const valid = await app.request("/api/readings");
    expect(valid.status).toBe(200);
    expect(dependencies.listReadings).toHaveBeenCalledWith(360);
    expect((await app.request("/api/readings?minutes=10081")).status).toBe(400);
    expect((await app.request("/api/readings?minutes=1.5")).status).toBe(400);
  });

  it("returns device state", async () => {
    const { app } = testApi();
    expect((await app.request("/api/device_state")).status).toBe(200);
  });

  it("validates air-conditioner settings before queueing the IR command", async () => {
    const { app, dependencies } = testApi();
    const post = (body: unknown) => app.request("/control/air-conditioner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect((await post({ ...airConditionerSettings, temp_c: 17 })).status).toBe(400);
    expect((await post({ ...airConditionerSettings, temp_c: 27.3 })).status).toBe(400);
    expect((await post({ ...airConditionerSettings, power: "on" })).status).toBe(400);
    expect((await post({ ...airConditionerSettings, mode: "auto" })).status).toBe(400);
    expect((await post({ ...airConditionerSettings, fan: "6" })).status).toBe(400);
    expect((await post({ ...airConditionerSettings, swing_v: "left" })).status).toBe(400);
    expect(dependencies.setAirConditioner).not.toHaveBeenCalled();

    const heat = await post({ power: false, mode: "heat", temp_c: 24.5, fan: "quiet", swing_v: "highest", extra: true });
    expect(heat.status).toBe(200);
    expect((await post({ ...airConditionerSettings, mode: "dry" })).status).toBe(200);
    expect(await heat.json()).toEqual({ status: "queued", command_id: "command-123" });
    expect(dependencies.setAirConditioner).toHaveBeenCalledWith({
      power: false, mode: "heat", temp_c: 24.5, fan: "quiet", swing_v: "highest",
    });
  });
});
