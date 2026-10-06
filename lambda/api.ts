import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Hono, type MiddlewareHandler } from "hono";
import { handle } from "@hono/aws-lambda";
import { ddb, requireTableName } from "./database";
import { setLight } from "./light-control";
import { setAirConditionerPreset, syncAirConditionerPreset as sendPresetSync } from "./air-conditioner-control";

const AIR_PRESET_IDS = [1, 2, 3, 4] as const;

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
  setAirConditionerPreset(command: AirConditionerCommand): Promise<SetAirConditionerCommandResult>;
  listAirConditionerPresets(): Promise<AirConditionerPresetRecord[]>;
  updateAirConditionerPreset(presetId: number, update: AirConditionerPresetUpdate): Promise<AirConditionerPresetRecord>;
  syncAirConditionerPreset(preset: AirConditionerPresetRecord): Promise<void>;
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

export type AirConditionerMode = "cool" | "heat";
export type AirConditionerFan = "auto" | "quiet" | "1" | "2" | "3" | "4" | "5";
export type AirConditionerVerticalSwing = "off" | "swing" | "highest" | "high" | "upper_middle" | "lower_middle" | "low" | "lowest" | "breeze" | "circulate";

export interface AirConditionerPreset {
  mode: AirConditionerMode;
  temp_c: number;
  fan: AirConditionerFan;
  swing_v: AirConditionerVerticalSwing;
}

export interface AirConditionerPresetRecord extends AirConditionerPreset {
  preset_id: number;
  name: string;
  revision: number;
  learned: boolean;
}

export type AirConditionerPresetUpdate = AirConditionerPreset & { name: string };

export type AirConditionerCommand =
  | { operation: "learn"; preset_id: number; preset: AirConditionerPreset; revision?: number }
  | { operation: "send"; preset_id: number; preset: AirConditionerPreset; revision?: number };

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
  in: { json: AirConditionerCommand };
  out: { json: AirConditionerCommand };
};

type AirConditionerPresetPatchInput = {
  in: { json: AirConditionerPresetUpdate; param: { presetId: string } };
  out: { json: AirConditionerPresetUpdate; param: { presetId: string } };
};

const AIR_CONDITIONER_MODES = new Set<AirConditionerMode>(["cool", "heat"]);
const AIR_CONDITIONER_FANS = new Set<AirConditionerFan>(["auto", "quiet", "1", "2", "3", "4", "5"]);
const AIR_CONDITIONER_SWING_V = new Set<AirConditionerVerticalSwing>([
  "off", "swing", "highest", "high", "upper_middle", "lower_middle", "low", "lowest", "breeze", "circulate",
]);

function isAirConditionerPreset(value: unknown): value is AirConditionerPreset {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preset = value as Record<string, unknown>;
  if (typeof preset.mode !== "string" || !AIR_CONDITIONER_MODES.has(preset.mode as AirConditionerMode)) return false;
  if (typeof preset.temp_c !== "number" || !Number.isFinite(preset.temp_c)
    || preset.temp_c < 10 || preset.temp_c > 32 || !Number.isInteger(preset.temp_c * 2)) return false;
  if (preset.mode === "cool" && preset.temp_c < 18) return false;
  return typeof preset.fan === "string" && AIR_CONDITIONER_FANS.has(preset.fan as AirConditionerFan)
    && typeof preset.swing_v === "string" && AIR_CONDITIONER_SWING_V.has(preset.swing_v as AirConditionerVerticalSwing);
}

function isAirConditionerCommand(value: unknown): value is AirConditionerCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  if (!Number.isInteger(command.preset_id) || Number(command.preset_id) < 1 || Number(command.preset_id) > 4) return false;
  if (command.revision !== undefined && (!Number.isInteger(command.revision) || Number(command.revision) < 0)) return false;
  if (!isAirConditionerPreset(command.preset)) return false;
  // 送信波形は本体のNVSに学習済みなので、Shadowには載せない(metadataで巨大化するため)
  return (command.operation === "learn" || command.operation === "send") && command.raw_data === undefined;
}

const validateAirConditionerPresetPatch: MiddlewareHandler<{}, "/api/air-conditioner-presets/:presetId", AirConditionerPresetPatchInput> = async (context, next) => {
  const rawId = context.req.param("presetId");
  const presetId = Number(rawId);
  if (!/^[1-4]$/.test(rawId)) return context.json({ error: "presetId must be between 1 and 4" }, 400);
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return context.json({ error: "invalid preset settings" }, 400);
  }
  const value = body as Record<string, unknown>;
  if (typeof value.name !== "string") return context.json({ error: "name must be a string" }, 400);
  const name = value.name.trim();
  const settings = {
    mode: value.mode,
    temp_c: value.temp_c,
    fan: value.fan,
    swing_v: value.swing_v,
  };
  if (name.length > 48 || !isAirConditionerPreset(settings)) {
    return context.json({ error: "invalid preset settings" }, 400);
  }
  context.req.addValidatedData("param", { presetId: rawId });
  context.req.addValidatedData("json", { ...settings, name: name || `プリセット ${presetId}` } as AirConditionerPresetUpdate);
  await next();
};

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
  if (!isAirConditionerCommand(body)) return context.json({ error: "invalid IR preset command" }, 400);
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
    .get("/api/air-conditioner-presets", async (context) => {
      return context.json(await dependencies.listAirConditionerPresets());
    })
    .patch("/api/air-conditioner-presets/:presetId", validateAirConditionerPresetPatch, async (context) => {
      const { presetId } = context.req.valid("param");
      const preset = await dependencies.updateAirConditionerPreset(Number(presetId), context.req.valid("json"));
      await dependencies.syncAirConditionerPreset(preset);
      return context.json(preset);
    })
    .post("/control/light", validateLightBody, async (context) => {
      const { is_light_on: isLightOn } = context.req.valid("json");
      return context.json(await dependencies.setLight(isLightOn));
    })
    .post("/control/air-conditioner", validateAirConditionerBody, async (context) => {
      return context.json(await dependencies.setAirConditionerPreset(context.req.valid("json")));
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

const DEFAULT_PRESET_SETTINGS: AirConditionerPreset = {
  mode: "cool", temp_c: 27, fan: "auto", swing_v: "off",
};

function presetFromRow(presetId: number, item?: Record<string, unknown>): AirConditionerPresetRecord {
  return {
    preset_id: presetId,
    name: typeof item?.name === "string" ? item.name : `プリセット ${presetId}`,
    mode: (item?.mode ?? DEFAULT_PRESET_SETTINGS.mode) as AirConditionerMode,
    temp_c: Number(item?.temp_c ?? DEFAULT_PRESET_SETTINGS.temp_c),
    fan: (item?.fan ?? DEFAULT_PRESET_SETTINGS.fan) as AirConditionerFan,
    swing_v: (item?.swing_v ?? DEFAULT_PRESET_SETTINGS.swing_v) as AirConditionerVerticalSwing,
    revision: Number.isInteger(item?.revision) ? Number(item?.revision) : 0,
    learned: typeof item?.learned_at === "string",
  };
}

async function listAirConditionerPresets(): Promise<AirConditionerPresetRecord[]> {
  const result = await ddb.send(new QueryCommand({
    TableName: requireTableName(),
    KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :first AND :last",
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: { ":pk": "AIR_PRESETS", ":first": "PRESET#1", ":last": "PRESET#4" },
  }));
  const byId = new Map<number, Record<string, unknown>>();
  for (const item of result.Items ?? []) {
    const match = typeof item.sk === "string" ? /^PRESET#([1-4])$/.exec(item.sk) : null;
    if (match) byId.set(Number(match[1]), item);
  }
  return AIR_PRESET_IDS.map((presetId) => presetFromRow(presetId, byId.get(presetId)));
}

async function updateAirConditionerPreset(
  presetId: number,
  update: AirConditionerPresetUpdate,
): Promise<AirConditionerPresetRecord> {
  const now = new Date().toISOString();
  const result = await ddb.send(new UpdateCommand({
    TableName: requireTableName(),
    Key: { pk: "AIR_PRESETS", sk: `PRESET#${presetId}` },
    UpdateExpression: "SET #name = :name, #mode = :mode, #temp = :temp, #fan = :fan, #swing = :swing, #updated = :updated, #revision = if_not_exists(#revision, :zero) + :one",
    ExpressionAttributeNames: {
      "#name": "name", "#mode": "mode", "#temp": "temp_c", "#fan": "fan",
      "#swing": "swing_v", "#updated": "updated_at", "#revision": "revision",
    },
    ExpressionAttributeValues: {
      ":name": update.name,
      ":mode": update.mode,
      ":temp": update.temp_c,
      ":fan": update.fan,
      ":swing": update.swing_v,
      ":updated": now,
      ":zero": 0,
      ":one": 1,
    },
    ReturnValues: "ALL_NEW",
  }));
  return presetFromRow(presetId, result.Attributes);
}

export const app = createApi({
  listReadings,
  getDeviceState,
  setLight,
  setAirConditionerPreset,
  listAirConditionerPresets,
  updateAirConditionerPreset,
  syncAirConditionerPreset: sendPresetSync,
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
