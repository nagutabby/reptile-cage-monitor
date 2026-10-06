import { randomUUID } from "node:crypto";
import { IoTDataPlaneClient, UpdateThingShadowCommand } from "@aws-sdk/client-iot-data-plane";
import type { AirConditionerSettings, SetAirConditionerResult } from "./api";

const THING_NAME = "reptile-cage-monitor-ir-controller";

let client: IoTDataPlaneClient | undefined;

function iotData(): IoTDataPlaneClient {
  const endpoint = process.env.IOT_ENDPOINT;
  if (!endpoint) throw new Error("Missing environment variable: IOT_ENDPOINT");
  client ??= new IoTDataPlaneClient({
    region: process.env.AWS_REGION,
    endpoint: `https://${endpoint}`,
  });
  return client;
}

export async function setAirConditioner(settings: AirConditionerSettings): Promise<SetAirConditionerResult> {
  const commandId = randomUUID();
  await iotData().send(new UpdateThingShadowCommand({
    thingName: THING_NAME,
    payload: Buffer.from(JSON.stringify({
      state: {
        desired: {
          air_conditioner_command_id: commandId,
          air_conditioner_power: settings.power,
          air_conditioner_mode: settings.mode,
          air_conditioner_temp_c: settings.temp_c,
          air_conditioner_fan: settings.fan,
          air_conditioner_swing_v: settings.swing_v,
        },
      },
    })),
  }));
  return { status: "queued", command_id: commandId };
}
