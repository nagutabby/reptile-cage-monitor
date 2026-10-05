import { randomUUID } from "node:crypto";
import { IoTDataPlaneClient, UpdateThingShadowCommand } from "@aws-sdk/client-iot-data-plane";
import type { AirConditionerCommand, SetAirConditionerCommandResult } from "./api";

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

export async function setAirConditionerPreset(
  command: AirConditionerCommand,
): Promise<SetAirConditionerCommandResult> {
  const commandId = randomUUID();
  await iotData().send(new UpdateThingShadowCommand({
    thingName: THING_NAME,
    payload: Buffer.from(JSON.stringify({
      state: {
        desired: {
          air_conditioner_command_id: commandId,
          air_conditioner_requested_at: Date.now(),
          air_conditioner_operation: command.operation,
          air_conditioner_mode: command.preset.mode,
          air_conditioner_temp_c: command.preset.temp_c,
          air_conditioner_fan: command.preset.fan,
          air_conditioner_swing_v: command.preset.swing_v,
          ...(command.operation === "send" ? { air_conditioner_raw_data: command.raw_data } : {}),
        },
      },
    })),
  }));
  return { status: "queued", command_id: commandId };
}
