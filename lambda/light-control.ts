import { UpdateThingShadowCommand } from "@aws-sdk/client-iot-data-plane";
import { IoTDataPlaneClient } from "@aws-sdk/client-iot-data-plane";
import { getShadow, updateDesired } from "./shadow-control";

let client: IoTDataPlaneClient | undefined;

function iotData(): IoTDataPlaneClient {
  client ??= new IoTDataPlaneClient({
    region: process.env.AWS_REGION,
    endpoint: `https://${process.env.IOT_ENDPOINT}`,
  });
  return client;
}

export async function setLight(isLightOn: boolean) {
  const commandAt = Date.now();
  return updateDesired(
    { is_light_on: isLightOn, light_command_at: commandAt },
    { commandAt },
  );
}

export async function reportState(state: Record<string, unknown>): Promise<void> {
  await iotData().send(new UpdateThingShadowCommand({
    thingName: "reptile-controller",
    payload: Buffer.from(JSON.stringify({ state: { reported: state } })),
  }));
}

export { getShadow };
