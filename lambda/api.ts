import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Hono, type MiddlewareHandler } from "hono";
import { handle } from "@hono/aws-lambda";
import { ddb, requireTableName } from "./database";
import { setAirConditionerSettings } from "./air-conditioner-control";
import { setLight } from "./light-control";

export interface ReadingRecord {
  id: number | string;
  event_id?: string;
  temp_c: number;
  humidity: number;
  recorded_at: string;
}

export interface ApiDependencies {
  listReadings(minutes: number): Promise<ReadingRecord[]>;
  getDeviceState(): Promise<DeviceState>;
  setLight(isLightOn: boolean): Promise<SetLightResult>;
  setAirConditionerSettings(settings: AirConditionerSettings): Promise<SetAirConditionerCommandResult>;
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

export interface SetLightResult {
  status: "updated" | "unchanged" | "superseded";
}

export type AirConditionerMode = "auto" | "cool" | "heat" | "dry" | "fan";
export type AirConditionerFan = "auto" | "quiet" | "1" | "2" | "3" | "4" | "5";
export type AirConditionerVerticalSwing = "off" | "swing" | "highest" | "high" | "upper_middle" | "lower_middle" | "low" | "lowest" | "breeze" | "circulate";
export type AirConditionerHorizontalSwing = "off" | "swing" | "wide" | "left_max" | "left" | "middle" | "right" | "right_max";
export type AirConditionerHumidity = "off" | "auto" | "40" | "45" | "50" | "55" | "60";
export type AirConditionerFreshAir = "off" | "on" | "high";
export type AirConditionerEyeTimer = "off" | "1h" | "3h";
export type AirConditionerBeep = "off" | "quiet" | "loud";
export type AirConditionerLight = "off" | "dim" | "bright";

export interface AirConditionerSettings {
  power: boolean;
  mode: AirConditionerMode;
  temp_c: number;
  fan: AirConditionerFan;
  swing_v: AirConditionerVerticalSwing;
  swing_h: AirConditionerHorizontalSwing;
  quiet: boolean;
  powerful: boolean;
  econo: boolean;
  eye: boolean;
  eye_auto: boolean;
  eye_timer: AirConditionerEyeTimer;
  purify: boolean;
  mold: boolean;
  clean: boolean;
  fresh_air: AirConditionerFreshAir;
  humidity: AirConditionerHumidity;
  beep: AirConditionerBeep;
  light: AirConditionerLight;
}

export interface SetAirConditionerCommandResult {
  status: "queued";
  command_id: string;
}

type ReadingsQueryInput = {
  in: { query: { minutes?: string | string[] } };
  out: { query: { minutes: number } };
};

type LightBodyInput = {
  in: { json: { is_light_on: boolean } };
  out: { json: { is_light_on: boolean } };
};

type AirConditionerBodyInput = {
  in: { json: AirConditionerSettings };
  out: { json: AirConditionerSettings };
};

const AIR_CONDITIONER_MODES = new Set<AirConditionerMode>(["auto", "cool", "heat", "dry", "fan"]);
const AIR_CONDITIONER_FANS = new Set<AirConditionerFan>(["auto", "quiet", "1", "2", "3", "4", "5"]);
const AIR_CONDITIONER_SWING_V = new Set<AirConditionerVerticalSwing>([
  "off", "swing", "highest", "high", "upper_middle", "lower_middle", "low", "lowest", "breeze", "circulate",
]);
const AIR_CONDITIONER_SWING_H = new Set<AirConditionerHorizontalSwing>([
  "off", "swing", "wide", "left_max", "left", "middle", "right", "right_max",
]);
const AIR_CONDITIONER_HUMIDITY = new Set<AirConditionerHumidity>(["off", "auto", "40", "45", "50", "55", "60"]);
const AIR_CONDITIONER_FRESH_AIR = new Set<AirConditionerFreshAir>(["off", "on", "high"]);
const AIR_CONDITIONER_EYE_TIMER = new Set<AirConditionerEyeTimer>(["off", "1h", "3h"]);
const AIR_CONDITIONER_BEEP = new Set<AirConditionerBeep>(["off", "quiet", "loud"]);
const AIR_CONDITIONER_LIGHT = new Set<AirConditionerLight>(["off", "dim", "bright"]);

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isAirConditionerSettings(value: unknown): value is AirConditionerSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  const mode = settings.mode;
  const humidity = settings.humidity;
  const temp = settings.temp_c;
  if (typeof mode !== "string" || !AIR_CONDITIONER_MODES.has(mode as AirConditionerMode)) return false;
  if (typeof temp !== "number" || !Number.isFinite(temp) || temp < 10 || temp > 32 || !Number.isInteger(temp * 2)) return false;
  if (mode === "cool" && temp < 18) return false;
  if (settings.quiet === true && settings.powerful === true) return false;
  if (typeof humidity !== "string" || !AIR_CONDITIONER_HUMIDITY.has(humidity as AirConditionerHumidity)) return false;
  if (mode === "heat" && !["off", "auto", "40", "45", "50"].includes(humidity)) return false;
  if (mode === "dry" && !["off", "auto", "50", "55", "60"].includes(humidity)) return false;
  if (mode !== "heat" && mode !== "dry" && humidity !== "off") return false;
  return isBoolean(settings.power)
    && typeof settings.fan === "string" && AIR_CONDITIONER_FANS.has(settings.fan as AirConditionerFan)
    && typeof settings.swing_v === "string" && AIR_CONDITIONER_SWING_V.has(settings.swing_v as AirConditionerVerticalSwing)
    && typeof settings.swing_h === "string" && AIR_CONDITIONER_SWING_H.has(settings.swing_h as AirConditionerHorizontalSwing)
    && isBoolean(settings.quiet)
    && isBoolean(settings.powerful)
    && isBoolean(settings.econo)
    && isBoolean(settings.eye)
    && isBoolean(settings.eye_auto)
    && typeof settings.eye_timer === "string" && AIR_CONDITIONER_EYE_TIMER.has(settings.eye_timer as AirConditionerEyeTimer)
    && isBoolean(settings.purify)
    && isBoolean(settings.mold)
    && isBoolean(settings.clean)
    && typeof settings.fresh_air === "string" && AIR_CONDITIONER_FRESH_AIR.has(settings.fresh_air as AirConditionerFreshAir)
    && typeof settings.beep === "string" && AIR_CONDITIONER_BEEP.has(settings.beep as AirConditionerBeep)
    && typeof settings.light === "string" && AIR_CONDITIONER_LIGHT.has(settings.light as AirConditionerLight);
}

const validateReadingsQuery: MiddlewareHandler<{}, "/api/readings", ReadingsQueryInput> = async (context, next) => {
  const rawMinutes = context.req.query("minutes");
  const minutes = rawMinutes === undefined ? 360 : Number(rawMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_080) {
    return context.json({ error: "minutes must be between 1 and 10080" }, 400);
  }
  context.req.addValidatedData("query", { minutes });
  await next();
};

const validateLightBody: MiddlewareHandler<{}, "/control/light", LightBodyInput> = async (context, next) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).is_light_on !== "boolean") {
    return context.json({ error: "is_light_on must be boolean" }, 400);
  }
  context.req.addValidatedData("json", { is_light_on: (body as { is_light_on: boolean }).is_light_on });
  await next();
};

const validateAirConditionerBody: MiddlewareHandler<{}, "/control/air-conditioner", AirConditionerBodyInput> = async (context, next) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid JSON body" }, 400);
  }
  if (!isAirConditionerSettings(body)) {
    return context.json({ error: "invalid Daikin312 settings" }, 400);
  }
  context.req.addValidatedData("json", body);
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
    .post("/control/light", validateLightBody, async (context) => {
      const { is_light_on: isLightOn } = context.req.valid("json");
      return context.json(await dependencies.setLight(isLightOn));
    })
    .post("/control/air-conditioner", validateAirConditionerBody, async (context) => {
      return context.json(await dependencies.setAirConditionerSettings(context.req.valid("json")));
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
  setLight,
  setAirConditionerSettings,
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
