import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Hono, type MiddlewareHandler } from "hono";
import { handle } from "@hono/aws-lambda";
import { ddb, requireTableName } from "./database";
import { setAirConditioner } from "./air-conditioner-control";

export interface ReadingRecord {
  id: number | string;
  event_id?: string;
  temp_c: number;
  humidity: number;
  battery?: number;
  recorded_at: string;
}

export interface ApiDependencies {
  listReadings(minutes: number): Promise<ReadingRecord[]>;
  getDeviceState(): Promise<DeviceState>;
  setAirConditioner(settings: AirConditionerSettings): Promise<SetAirConditionerResult>;
  getPublicConfig(): PublicConfig;
}

export interface DeviceState {
  is_light_on: boolean | null;
  is_light_on_changed_at: string | null;
  is_heater_on: boolean | null;
  is_heater_on_changed_at: string | null;
}

export interface PublicConfig {
  region: string;
  endpoint: string;
  identityPoolId: string;
  userPoolId: string;
  clientId: string;
  cognitoDomain: string;
}

export type AirConditionerMode = "cool" | "heat" | "dry";
export type AirConditionerFan = "auto" | "quiet" | "1" | "2" | "3" | "4" | "5";
export type AirConditionerVerticalSwing = "off" | "swing" | "highest" | "high" | "upper_middle" | "lower_middle" | "low" | "lowest" | "breeze" | "circulate";

export interface AirConditionerSettings {
  power: boolean;
  mode: AirConditionerMode;
  temp_c: number;
  fan: AirConditionerFan;
  swing_v: AirConditionerVerticalSwing;
}

export interface SetAirConditionerResult {
  status: "queued";
  command_id: string;
}

type ReadingsQueryInput = {
  in: { query: { minutes?: string | string[] } };
  out: { query: { minutes: number } };
};

type AirConditionerBodyInput = {
  in: { json: AirConditionerSettings };
  out: { json: AirConditionerSettings };
};

const AIR_CONDITIONER_MODES = new Set<AirConditionerMode>(["cool", "heat", "dry"]);
const AIR_CONDITIONER_FANS = new Set<AirConditionerFan>(["auto", "quiet", "1", "2", "3", "4", "5"]);
const AIR_CONDITIONER_SWING_V = new Set<AirConditionerVerticalSwing>([
  "off", "swing", "highest", "high", "upper_middle", "lower_middle", "low", "lowest", "breeze", "circulate",
]);

function isAirConditionerSettings(value: unknown): value is AirConditionerSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  if (typeof settings.power !== "boolean") return false;
  if (typeof settings.mode !== "string" || !AIR_CONDITIONER_MODES.has(settings.mode as AirConditionerMode)) return false;
  if (typeof settings.temp_c !== "number" || !Number.isFinite(settings.temp_c)
    || settings.temp_c < 10 || settings.temp_c > 32 || !Number.isInteger(settings.temp_c * 2)) return false;
  if (settings.mode === "cool" && settings.temp_c < 18) return false;
  return typeof settings.fan === "string" && AIR_CONDITIONER_FANS.has(settings.fan as AirConditionerFan)
    && typeof settings.swing_v === "string" && AIR_CONDITIONER_SWING_V.has(settings.swing_v as AirConditionerVerticalSwing);
}

const validateReadingsQuery: MiddlewareHandler<{}, "/api/readings", ReadingsQueryInput> = async (context, next) => {
  const rawMinutes = context.req.query("minutes");
  const minutes = rawMinutes === undefined ? 360 : Number(rawMinutes);
  if (!Number.isInteger(minutes) || minutes < 30 || minutes > 4_320) {
    return context.json({ error: "minutes must be between 30 and 4320" }, 400);
  }
  context.req.addValidatedData("query", { minutes });
  await next();
};

const validateAirConditionerBody: MiddlewareHandler<{}, "/control/air-conditioner", AirConditionerBodyInput> = async (context, next) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid JSON body" }, 400);
  }
  if (!isAirConditionerSettings(body)) return context.json({ error: "invalid air-conditioner settings" }, 400);
  const { power, mode, temp_c, fan, swing_v } = body;
  context.req.addValidatedData("json", { power, mode, temp_c, fan, swing_v });
  await next();
};

export function createApi(dependencies: ApiDependencies) {
  return new Hono()
    .get("/healthz", (context) => context.json({ status: "ok" }))
    .get("/api/config", (context) => context.json(dependencies.getPublicConfig(), 200, {
      "Cache-Control": "public, max-age=300",
    }))
    .get("/api/readings", validateReadingsQuery, async (context) => {
      const { minutes } = context.req.valid("query");
      return context.json(await dependencies.listReadings(minutes));
    })
    .get("/api/device_state", async (context) => context.json(await dependencies.getDeviceState()))
    .post("/control/air-conditioner", validateAirConditionerBody, async (context) => {
      return context.json(await dependencies.setAirConditioner(context.req.valid("json")));
    });
}

function isoSeconds(value: Date): string {
  return `${value.toISOString().slice(0, 19)}+00:00`;
}

async function listReadings(minutes: number): Promise<ReadingRecord[]> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const firstKey = `R#${cutoff.toISOString().slice(0, 19)}Z#`;
  const lastKey = `R#${now.toISOString().slice(0, 19)}Z#~`;
  const rows: ReadingRecord[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: requireTableName(),
      KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :start AND :end",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": "READINGS",
        ":start": firstKey,
        ":end": lastKey,
      },
      ExclusiveStartKey: exclusiveStartKey,
      ScanIndexForward: true,
    }));
    for (const item of result.Items ?? []) {
      rows.push({
        id: item.id ?? item.event_id ?? String(item.sk),
        ...(typeof item.event_id === "string" ? { event_id: item.event_id } : {}),
        temp_c: Number(item.temp_c),
        humidity: Number(item.humidity),
        ...(typeof item.battery === "number" ? { battery: item.battery } : {}),
        recorded_at: String(item.recorded_at),
      });
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rows;
}

async function getDeviceState(): Promise<DeviceState> {
  const result = await ddb.send(new GetCommand({
    TableName: requireTableName(),
    Key: { pk: "STATE", sk: "DEVICE" },
  }));
  const item = result.Item;
  return {
    is_light_on: (item?.is_light_on ?? null) as boolean | null,
    is_light_on_changed_at: (item?.is_light_on_changed_at ?? item?.reported_at ?? null) as string | null,
    is_heater_on: (item?.is_heater_on ?? null) as boolean | null,
    is_heater_on_changed_at: (item?.is_heater_on_changed_at ?? item?.reported_at ?? null) as string | null,
  };
}

export const app = createApi({
  listReadings,
  getDeviceState,
  setAirConditioner,
  getPublicConfig: (): PublicConfig => ({
    region: process.env.AWS_REGION ?? "ap-northeast-1",
    endpoint: required("IOT_ENDPOINT"),
    identityPoolId: required("IDENTITY_POOL_ID"),
    userPoolId: required("USER_POOL_ID"),
    clientId: required("ASTRO_CLIENT_ID"),
    cognitoDomain: required("COGNITO_DOMAIN"),
  }),
});
export type AppType = typeof app;
export const handler = handle(app);

export { isoSeconds };

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
