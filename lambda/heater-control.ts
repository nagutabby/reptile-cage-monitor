import { GetRetainedMessageCommand, IoTDataPlaneClient } from "@aws-sdk/client-iot-data-plane";
import { temperatureFromRetainedMessage, updateDesired } from "./shadow-control";

let client: IoTDataPlaneClient | undefined;

function iotData(): IoTDataPlaneClient {
  client ??= new IoTDataPlaneClient({
    region: process.env.AWS_REGION,
    endpoint: `https://${process.env.IOT_ENDPOINT}`,
  });
  return client;
}

export async function handler(): Promise<{ status: string; temperature_available: boolean }> {
  let temperature: number | null = null;
  try {
    const message = await iotData().send(new GetRetainedMessageCommand({
      topic: "reptile/cage/telemetry",
    }));
    temperature = temperatureFromRetainedMessage(message, Date.now());
  } catch (error) {
    if (!(error instanceof Error && error.name === "ResourceNotFoundException")) throw error;
  }

  const result = await updateDesired(
    { is_heater_on: temperature === null || temperature < 32 },
    { seedLight: true },
  );
  return { ...result, temperature_available: temperature !== null };
}
