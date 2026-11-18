import { GetThingShadowCommand, IoTDataPlaneClient } from "@aws-sdk/client-iot-data-plane";
import { CreateThingCommand, IoTClient } from "@aws-sdk/client-iot";
import { beforeAll, describe, expect, it } from "vitest";
import { createMonitorTable, emulatorHost } from "./helpers";

const TABLE_NAME = "integration-api-data";
const THING_NAME = "reptile-cage-monitor-ir-controller";

type Api = typeof import("../../lambda/api");
type Ingest = typeof import("../../lambda/ingest");
let app: Api["app"];
let ingest: Ingest;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

beforeAll(async () => {
  process.env.TABLE_NAME = TABLE_NAME;
  process.env.IOT_ENDPOINT = emulatorHost();
  process.env.IDENTITY_POOL_ID = "us-east-1:identity-pool";
  process.env.USER_POOL_ID = "us-east-1_user-pool";
  process.env.ASTRO_CLIENT_ID = "public-client";
  process.env.COGNITO_DOMAIN = "login.example.com";
  ({ app } = await import("../../lambda/api"));
  ingest = await import("../../lambda/ingest");

  await createMonitorTable(TABLE_NAME);
  await new IoTClient({}).send(new CreateThingCommand({ thingName: THING_NAME }));
});

describe("API against AWS Emulator", () => {
  it("returns empty values before anything is ingested", async () => {
    const readings = await app.request("/api/readings");
    expect(readings.status).toBe(200);
    expect(await readings.json()).toEqual([]);

    expect(await (await app.request("/api/latest_reading")).json()).toEqual({
      temp_c: null, temp_c_recorded_at: null,
      humidity: null, humidity_recorded_at: null,
      battery: null, battery_recorded_at: null,
    });
    expect(await (await app.request("/api/device_state")).json()).toMatchObject({
      is_light_on: null,
      is_heater_on: null,
    });
  });

  it("serves what the ingest handler stored", async () => {
    await ingest.handler({ event_id: "old", observed_at: minutesAgo(2 * 24 * 60), temp_c: 26, humidity: 48 });
    await ingest.handler({ event_id: "mid", observed_at: minutesAgo(20), temp_c: 27, humidity: 50 });
    await ingest.handler({ event_id: "new", observed_at: minutesAgo(5), temp_c: 28, humidity: 55 });

    const recent = await (await app.request("/api/readings?minutes=30")).json() as Array<Record<string, unknown>>;
    expect(recent.map((row) => row.event_id)).toEqual(["mid", "new"]);
    expect(recent[1]).toMatchObject({ temp_c: 28, humidity: 55 });

    const all = await (await app.request("/api/readings?minutes=4320")).json() as Array<Record<string, unknown>>;
    expect(all.map((row) => row.event_id)).toEqual(["old", "mid", "new"]);

    expect(await (await app.request("/api/latest_reading")).json()).toMatchObject({ temp_c: 28, humidity: 55 });
  });

  it("rejects an invalid period without querying", async () => {
    expect((await app.request("/api/readings?minutes=29")).status).toBe(400);
    expect((await app.request("/api/readings?minutes=4321")).status).toBe(400);
  });

  it("serves the device state reported by the controller", async () => {
    await ingest.handler({
      event_id: "state-1",
      observed_at: minutesAgo(1),
      is_light_on: true,
      is_heater_on: false,
    });

    expect(await (await app.request("/api/device_state")).json()).toMatchObject({
      is_light_on: true,
      is_heater_on: false,
    });
  });

  it("serves the public configuration from the environment", async () => {
    const response = await app.request("/api/config");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      identityPoolId: "us-east-1:identity-pool",
      userPoolId: "us-east-1_user-pool",
      clientId: "public-client",
    });
  });

  it("queues an air-conditioner command in the IoT thing shadow", async () => {
    const settings = { power: true, mode: "cool", temp_c: 26.5, fan: "auto", swing_v: "off" };
    const response = await app.request("/control/air-conditioner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    expect(response.status).toBe(200);
    const { status, command_id: commandId } = await response.json() as { status: string; command_id: string };
    expect(status).toBe("queued");

    const shadow = await new IoTDataPlaneClient({}).send(new GetThingShadowCommand({ thingName: THING_NAME }));
    const document = JSON.parse(Buffer.from(shadow.payload as Uint8Array).toString());
    expect(document.state.desired).toEqual({
      air_conditioner_command_id: commandId,
      air_conditioner_power: true,
      air_conditioner_mode: "cool",
      air_conditioner_temp_c: 26.5,
      air_conditioner_fan: "auto",
      air_conditioner_swing_v: "off",
    });
  });
});
