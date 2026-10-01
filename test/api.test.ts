import { describe, expect, it, vi } from "vitest";
import { createApi } from "../lambda/api";

function testApi() {
  const dependencies = {
    listReadings: vi.fn(async () => [{ id: 1, temp_c: 27.2, humidity: 52, recorded_at: "2026-09-30T00:00:00+00:00" }]),
    getDeviceState: vi.fn(async () => ({
      is_light_on: false,
      is_light_on_changed_at: "2026-09-30T00:00:00+00:00",
      is_heater_on: true,
      is_heater_on_changed_at: "2026-09-30T00:00:00+00:00",
    })),
    setLight: vi.fn(async (isLightOn: boolean) => ({ status: "updated", is_light_on: isLightOn })),
    getPublicConfig: vi.fn(() => ({ region: "ap-northeast-1", endpoint: "example.iot.ap-northeast-1.amazonaws.com" })),
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
});
