import {
  GetThingShadowCommand,
  IoTDataPlaneClient,
  UpdateThingShadowCommand,
} from "@aws-sdk/client-iot-data-plane";

const THING_NAME = "reptile-cage-monitor-controller";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

let dataClient: IoTDataPlaneClient | undefined;

function iotData(): IoTDataPlaneClient {
  dataClient ??= new IoTDataPlaneClient({
    region: process.env.AWS_REGION,
    endpoint: `https://${required("IOT_ENDPOINT")}`,
  });
  return dataClient;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export interface ShadowDocument {
  version?: number;
  state?: { desired?: Record<string, unknown> };
}

export async function getShadow(): Promise<ShadowDocument> {
  try {
    const response = await iotData().send(new GetThingShadowCommand({ thingName: THING_NAME }));
    if (!response.payload) return { state: {} };
    return JSON.parse(await response.payload.transformToString()) as ShadowDocument;
  } catch (error) {
    if (error instanceof Error && error.name === "ResourceNotFoundException") {
      return { state: {} };
    }
    throw error;
  }
}

export async function updateDesired(
  values: Record<string, string | number | boolean>,
  options: { commandAt?: number; seedLight?: boolean } = {},
): Promise<{ status: "updated" | "unchanged" | "superseded" }> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const shadow = await getShadow();
    const desired = shadow.state?.desired ?? {};
    if (
      options.commandAt !== undefined &&
      typeof desired.light_command_at === "number" &&
      desired.light_command_at > options.commandAt
    ) {
      return { status: "superseded" };
    }

    const changes: Record<string, string | number | boolean> = { ...values };
    if (options.seedLight && typeof desired.is_light_on !== "boolean") {
      const now = new Date();
      const jst = new Date(now.getTime() + JST_OFFSET_MS);
      const hour = jst.getUTCHours();
      const boundaryHour = hour >= 19 || hour < 7 ? 19 : 7;
      const boundary = new Date(Date.UTC(
        jst.getUTCFullYear(),
        jst.getUTCMonth(),
        jst.getUTCDate() - (hour < 7 ? 1 : 0),
        boundaryHour,
      ));
      changes.is_light_on = boundaryHour === 7;
      changes.light_command_at = boundary.getTime() - JST_OFFSET_MS;
    }

    if (Object.entries(changes).every(([key, value]) => desired[key] === value)) {
      return { status: "unchanged" };
    }

    const state = { desired: changes };
    try {
      await iotData().send(new UpdateThingShadowCommand({
        thingName: THING_NAME,
        payload: Buffer.from(JSON.stringify({
          state,
          ...(shadow.version === undefined ? {} : { version: shadow.version }),
        })),
      }));
      return { status: "updated" };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "ConflictException" || error.name === "VersionConflictException")
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Device Shadow remained in conflict after retries");
}

export function currentTemperature(reading: unknown, nowMs: number): number | null {
  if (!reading || typeof reading !== "object") return null;
  const value = reading as Record<string, unknown>;
  const temperature = value.temp_c;
  const observedAt = value.observed_at;
  if (
    typeof temperature !== "number" ||
    !Number.isFinite(temperature) ||
    typeof observedAt !== "string"
  ) return null;

  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs) || observedMs > nowMs || nowMs - observedMs > 180_000) {
    return null;
  }
  return temperature;
}

export function temperatureFromRetainedMessage(message: {
  payload?: Uint8Array;
  lastModifiedTime?: Date | number;
}, nowMs: number): number | null {
  if (!message.payload || !message.lastModifiedTime) return null;
  const lastModifiedMs = message.lastModifiedTime instanceof Date
    ? message.lastModifiedTime.getTime()
    : message.lastModifiedTime;
  const age = nowMs - lastModifiedMs;
  if (!Number.isFinite(lastModifiedMs) || age < 0 || age > 180_000) return null;
  try {
    return currentTemperature(JSON.parse(Buffer.from(message.payload).toString("utf8")), nowMs);
  } catch {
    return null;
  }
}

export function scheduledEpochMs(now: Date, hour: 7 | 19): number {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  return Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), hour) - JST_OFFSET_MS;
}
