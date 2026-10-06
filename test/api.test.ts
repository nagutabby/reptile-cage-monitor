import { describe, expect, it, vi } from "vitest";
import { createApi, type AirConditionerCommand, type AirConditionerPresetUpdate } from "../lambda/api";

const presetSettings = { mode: "cool" as const, temp_c: 27, fan: "auto" as const, swing_v: "off" as const };
const presets = [1, 2, 3, 4].map((preset_id) => ({
  preset_id,
  ...presetSettings,
  name: `Preset ${preset_id}`,
  revision: 0,
  learned: false,
}));

function testApi() {
  const dependencies = {
    listReadings: vi.fn(async () => [{ id: 1, temp_c: 27.2, humidity: 52, recorded_at: "2026-09-30T00:00:00+00:00" }]),
    getDeviceState: vi.fn(async () => ({
      is_light_on: false,
      is_light_on_changed_at: "2026-09-30T00:00:00+00:00",
      is_heater_on: true,
      is_heater_on_changed_at: "2026-09-30T00:00:00+00:00",
    })),
    setLight: vi.fn(async (isLightOn: boolean) => ({ status: "updated" as const, is_light_on: isLightOn })),
    setAirConditionerPreset: vi.fn(async (_command: AirConditionerCommand) => ({
      status: "queued" as const,
      command_id: "command-123",
    })),
    listAirConditionerPresets: vi.fn(async () => presets),
    updateAirConditionerPreset: vi.fn(async (presetId: number, update: AirConditionerPresetUpdate) => ({
      preset_id: presetId,
      ...update,
      revision: 1,
      learned: false,
    })),
    syncAirConditionerPreset: vi.fn(async () => undefined),
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

  it("returns device state and validates manual light requests", async () => {
    const { app, dependencies } = testApi();
    expect((await app.request("/api/device_state")).status).toBe(200);
    expect((await app.request("/control/light", { method: "POST", body: "{" })).status).toBe(400);
    expect((await app.request("/control/light", { method: "POST", body: JSON.stringify({ is_light_on: 1 }) })).status).toBe(400);
    const result = await app.request("/control/light", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_light_on: true }),
    });
    expect(result.status).toBe(200);
    expect(dependencies.setLight).toHaveBeenCalledWith(true);
  });

  it("lists four air-conditioner slots and validates updates before syncing the device", async () => {
    const { app, dependencies } = testApi();
    const listed = await app.request("/api/air-conditioner-presets");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toHaveLength(4);

    const invalidId = await app.request("/api/air-conditioner-presets/5", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...presetSettings, name: "Invalid" }),
    });
    expect(invalidId.status).toBe(400);

    const invalidSettings = await app.request("/api/air-conditioner-presets/2", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...presetSettings, temp_c: 17, name: "Invalid" }),
    });
    expect(invalidSettings.status).toBe(400);
    const invalidName = await app.request("/api/air-conditioner-presets/2", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...presetSettings, name: 123 }),
    });
    expect(invalidName.status).toBe(400);
    expect(dependencies.updateAirConditionerPreset).not.toHaveBeenCalled();

    const updated = await app.request("/api/air-conditioner-presets/2", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...presetSettings, name: "Night" }),
    });
    expect(updated.status).toBe(200);
    expect(dependencies.updateAirConditionerPreset).toHaveBeenCalledWith(2, { ...presetSettings, name: "Night" });
    expect(dependencies.syncAirConditionerPreset).toHaveBeenCalledWith(expect.objectContaining({ preset_id: 2, name: "Night" }));
  });

});
