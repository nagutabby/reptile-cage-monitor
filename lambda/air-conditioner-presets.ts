import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { IoTEvent } from "aws-lambda";
import { ddb, requireTableName } from "./database";

const VALID_MODES = new Set(["cool", "heat"]);
const VALID_FANS = new Set(["auto", "quiet", "1", "2", "3", "4", "5"]);
const VALID_SWINGS = new Set([
  "off", "swing", "highest", "high", "upper_middle", "lower_middle", "low", "lowest", "breeze", "circulate",
]);

export interface CapturedPresetEvent {
  status: "captured";
  preset_id: number;
  name?: string;
  revision?: number;
  reported_at?: number | string;
  preset: { mode: string; temp_c: number; fan: string; swing_v: string };
}

export function parseCapturedPresetEvent(value: unknown): CapturedPresetEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (event.status !== "captured") return null;
  if (!Number.isInteger(event.preset_id) || Number(event.preset_id) < 1 || Number(event.preset_id) > 4) return null;
  const preset = event.preset as Record<string, unknown> | undefined;
  if (!preset || typeof preset !== "object" || Array.isArray(preset)) return null;
  if (typeof preset.mode !== "string" || !VALID_MODES.has(preset.mode)) return null;
  if (typeof preset.temp_c !== "number" || !Number.isFinite(preset.temp_c)
    || preset.temp_c < 10 || preset.temp_c > 32 || !Number.isInteger(preset.temp_c * 2)
    || (preset.mode === "cool" && preset.temp_c < 18)) return null;
  if (typeof preset.fan !== "string" || !VALID_FANS.has(preset.fan)
    || typeof preset.swing_v !== "string" || !VALID_SWINGS.has(preset.swing_v)) return null;
  if (event.name !== undefined && (typeof event.name !== "string" || event.name.length > 48)) return null;
  if (event.revision !== undefined && (!Number.isInteger(event.revision) || Number(event.revision) < 0)) return null;
  return event as unknown as CapturedPresetEvent;
}

function eventTime(value: number | string | undefined): string {
  if (typeof value === "number" && Number.isFinite(value) && value > 1_700_000_000) {
    const millis = value * 1000;
    if (Number.isFinite(millis) && Math.abs(millis) <= 8.64e15) return new Date(millis).toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

export async function handler(event: IoTEvent | Record<string, unknown>): Promise<{ status: string }> {
  const captured = parseCapturedPresetEvent(event);
  if (!captured) return { status: "ignored" };

  const presetId = captured.preset_id;
  const updatedAt = eventTime(captured.reported_at);
  await ddb.send(new UpdateCommand({
    TableName: requireTableName(),
    Key: { pk: "AIR_PRESETS", sk: `PRESET#${presetId}` },
    UpdateExpression: "SET #learned = :learned, #updated = :updated, #mode = if_not_exists(#mode, :mode), #temp = if_not_exists(#temp, :temp), #fan = if_not_exists(#fan, :fan), #swing = if_not_exists(#swing, :swing), #name = if_not_exists(#name, :name), #revision = if_not_exists(#revision, :revision) REMOVE #raw",
    ExpressionAttributeNames: {
      "#raw": "raw_data", "#learned": "learned_at", "#updated": "updated_at", "#mode": "mode",
      "#temp": "temp_c", "#fan": "fan", "#swing": "swing_v", "#name": "name", "#revision": "revision",
    },
    ExpressionAttributeValues: {
      ":learned": updatedAt,
      ":updated": updatedAt,
      ":mode": captured.preset.mode,
      ":temp": captured.preset.temp_c,
      ":fan": captured.preset.fan,
      ":swing": captured.preset.swing_v,
      ":name": captured.name?.trim() || `プリセット ${presetId}`,
      ":revision": captured.revision ?? 0,
    },
  }));
  return { status: "saved" };
}
