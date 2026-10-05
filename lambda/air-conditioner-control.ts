import { randomUUID } from "node:crypto";
import { IoTDataPlaneClient, UpdateThingShadowCommand } from "@aws-sdk/client-iot-data-plane";
import type { AirConditionerSettings, SetAirConditionerCommandResult } from "./api";

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

export async function setAirConditionerSettings(
  settings: AirConditionerSettings,
): Promise<SetAirConditionerCommandResult> {
  const commandId = randomUUID();
  await iotData().send(new UpdateThingShadowCommand({
    thingName: THING_NAME,
    payload: Buffer.from(JSON.stringify({
      state: {
        desired: {
          air_conditioner_command_id: commandId,
          air_conditioner_requested_at: Date.now(),
          ...Object.fromEntries(
            Object.entries(settings).map(([key, value]) => [`air_conditioner_${key}`, value]),
          ),
        },
      },
    })),
  }));
  return { status: "queued", command_id: commandId };
}
