import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { IoTEvent } from "aws-lambda";
import { ddb, requireTableName } from "./database";

const TEMP_MIN_C = 24;
const TEMP_MAX_C = 32;
const HUMIDITY_MIN = 40;
const HUMIDITY_MAX = 90;
const ALERT_RESEND_MS = 60 * 60 * 1000;
const ssm = new SSMClient({ region: process.env.AWS_REGION });

let lineConfig: { token: string; to: string } | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function normalizeRecordedAt(value: string): string | null {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return `${parsed.toISOString().slice(0, 19)}Z`;
}

export interface Telemetry {
  event_id: string;
  observed_at: string;
  temp_c: number;
  humidity: number;
}

export function parseTelemetry(value: unknown): (Telemetry & { recorded_at: string }) | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const recordedAt = typeof item.observed_at === "string" ? normalizeRecordedAt(item.observed_at) : null;
  if (
    typeof item.event_id !== "string" ||
    item.event_id.length < 1 || item.event_id.length > 80 ||
    !/^[A-Za-z0-9:_-]+$/.test(item.event_id) ||
    recordedAt === null ||
    typeof item.temp_c !== "number" || !Number.isFinite(item.temp_c) || item.temp_c < -20 || item.temp_c > 60 ||
    typeof item.humidity !== "number" || !Number.isFinite(item.humidity) || item.humidity < 0 || item.humidity > 100
  ) return null;
  return {
    event_id: item.event_id,
    observed_at: item.observed_at as string,
    temp_c: item.temp_c,
    humidity: item.humidity,
    recorded_at: recordedAt,
  };
}

async function getLineConfig(): Promise<{ token: string; to: string }> {
  if (lineConfig) return lineConfig;
  const [token, destination] = await Promise.all([
    ssm.send(new GetParameterCommand({
      Name: required("LINE_TOKEN_PARAMETER"),
      WithDecryption: true,
    })),
    ssm.send(new GetParameterCommand({
      Name: required("LINE_TO_ID_PARAMETER"),
      WithDecryption: true,
    })),
  ]);
  const tokenValue = token.Parameter?.Value;
  const toValue = destination.Parameter?.Value;
  if (!tokenValue || !toValue) throw new Error("LINE notification settings are missing");
  lineConfig = { token: tokenValue, to: toValue };
  return lineConfig;
}

async function pushLine(message: string): Promise<void> {
  const config = await getLineConfig();
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to: config.to, messages: [{ type: "text", text: message }] }),
  });
  if (!response.ok) throw new Error(`LINE push failed with status ${response.status}`);
}

interface AlertState {
  is_abnormal?: boolean;
  last_alert_at?: number;
  evaluated_at?: string;
}

export function isAbnormal(telemetry: Pick<Telemetry, "temp_c" | "humidity">): boolean {
  return telemetry.temp_c < TEMP_MIN_C || telemetry.temp_c > TEMP_MAX_C ||
    telemetry.humidity < HUMIDITY_MIN || telemetry.humidity > HUMIDITY_MAX;
}

export function shouldNotify(
  abnormalNow: boolean,
  previous: Pick<AlertState, "is_abnormal" | "last_alert_at"> | undefined,
  now: number,
): boolean {
  return abnormalNow && (
    previous?.is_abnormal !== true ||
    previous.last_alert_at === undefined ||
    now - previous.last_alert_at >= ALERT_RESEND_MS
  );
}

function alertMessage(telemetry: Telemetry): string {
  return [
    "[異常値検知] ヒョウモントカゲモドキ ケージ",
    `温度: ${telemetry.temp_c.toFixed(1)}C / 湿度: ${telemetry.humidity.toFixed(0)}%`,
    `許容範囲: 温度${TEMP_MIN_C}-${TEMP_MAX_C}C, 湿度${HUMIDITY_MIN}-${HUMIDITY_MAX}%`,
  ].join("\n");
}

async function evaluateAndNotify(telemetry: Telemetry & { recorded_at: string }): Promise<void> {
  const key = { pk: "ALERT", sk: "ENVIRONMENT" };
  const abnormalNow = isAbnormal(telemetry);
  const now = Date.now();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await ddb.send(new GetCommand({ TableName: requireTableName(), Key: key }));
    const previous = current.Item as AlertState | undefined;
    if (previous?.evaluated_at && previous.evaluated_at >= telemetry.recorded_at) return;

    const lastAlertAt = previous?.last_alert_at;
    const notify = shouldNotify(abnormalNow, previous, now);
    const next: AlertState & { pk: string; sk: string } = {
      ...key,
      is_abnormal: abnormalNow,
      evaluated_at: telemetry.recorded_at,
      ...(notify ? { last_alert_at: now } : lastAlertAt === undefined ? {} : { last_alert_at: lastAlertAt }),
    };
    try {
      await ddb.send(new PutCommand({
        TableName: requireTableName(),
        Item: next,
        ConditionExpression: previous?.evaluated_at
          ? "#evaluated = :previous"
          : "attribute_not_exists(#pk)",
        ExpressionAttributeNames: previous?.evaluated_at
          ? { "#evaluated": "evaluated_at" }
          : { "#pk": "pk" },
        ...(previous?.evaluated_at ? { ExpressionAttributeValues: { ":previous": previous.evaluated_at } } : {}),
      }));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) continue;
      throw error;
    }

    if (!notify) return;
    try {
      await pushLine(alertMessage(telemetry));
    } catch (error) {
      try {
        await ddb.send(new PutCommand({
          TableName: requireTableName(),
          Item: {
            ...key,
            is_abnormal: previous?.is_abnormal ?? false,
            evaluated_at: telemetry.recorded_at,
            ...(lastAlertAt === undefined ? {} : { last_alert_at: lastAlertAt }),
          },
          ConditionExpression: "#evaluated = :current",
          ExpressionAttributeNames: { "#evaluated": "evaluated_at" },
          ExpressionAttributeValues: { ":current": telemetry.recorded_at },
        }));
      } catch (rollbackError) {
        console.error("Could not release failed LINE alert reservation", rollbackError);
      }
      throw error;
    }
    return;
  }
  throw new Error("Alert state changed repeatedly during update");
}

async function saveTelemetry(value: unknown): Promise<void> {
  const telemetry = parseTelemetry(value);
  if (!telemetry) throw new Error("Invalid telemetry event");
  const key = {
    pk: "READINGS",
    sk: `R#${telemetry.recorded_at}#${telemetry.event_id}`,
  };
  try {
    await ddb.send(new PutCommand({
      TableName: requireTableName(),
      Item: {
        ...key,
        id: telemetry.event_id,
        event_id: telemetry.event_id,
        temp_c: telemetry.temp_c,
        humidity: telemetry.humidity,
        recorded_at: `${telemetry.recorded_at.slice(0, 19)}+00:00`,
      },
      ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    }));
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
  await evaluateAndNotify(telemetry);
}

async function saveState(value: unknown): Promise<void> {
  if (!value || typeof value !== "object") throw new Error("Invalid device state event");
  const state = value as Record<string, unknown>;
  const recordedAt = typeof state.observed_at === "string" ? normalizeRecordedAt(state.observed_at) : null;
  if (
    recordedAt === null ||
    typeof state.event_id !== "string" ||
    typeof state.is_light_on !== "boolean" ||
    typeof state.is_heater_on !== "boolean"
  ) throw new Error("Invalid device state event");

  try {
    await ddb.send(new PutCommand({
      TableName: requireTableName(),
      Item: {
        pk: "STATE",
        sk: "DEVICE",
        is_light_on: state.is_light_on,
        is_heater_on: state.is_heater_on,
        reported_at: `${recordedAt.slice(0, 19)}+00:00`,
        event_id: state.event_id,
      },
      ConditionExpression: "attribute_not_exists(#reported) OR #reported < :reported",
      ExpressionAttributeNames: { "#reported": "reported_at" },
      ExpressionAttributeValues: { ":reported": `${recordedAt.slice(0, 19)}+00:00` },
    }));
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
}

async function saveShadow(value: unknown): Promise<void> {
  if (!value || typeof value !== "object") throw new Error("Invalid shadow document");
  const document = value as Record<string, unknown>;
  const current = document.current as Record<string, unknown> | undefined;
  const state = current?.state as Record<string, unknown> | undefined;
  const desired = state?.desired as Record<string, unknown> | undefined;
  const reported = state?.reported as Record<string, unknown> | undefined;
  const version = current?.version;
  const timestamp = document.timestamp;
  if (!Number.isInteger(version) || !Number.isInteger(timestamp)) throw new Error("Invalid shadow document");

  const fields = [
    desired?.is_light_on,
    desired?.is_heater_on,
    reported?.is_light_on,
    reported?.is_heater_on,
  ];
  if (fields.some((field) => field !== undefined && typeof field !== "boolean")) {
    throw new Error("Invalid shadow state values");
  }
  try {
    await ddb.send(new PutCommand({
      TableName: requireTableName(),
      Item: {
        pk: "SHADOW",
        sk: "DEVICE",
        version,
        desired_light: desired?.is_light_on ?? null,
        desired_heater: desired?.is_heater_on ?? null,
        reported_light: reported?.is_light_on ?? null,
        reported_heater: reported?.is_heater_on ?? null,
        updated_at: new Date(Number(timestamp) * 1000).toISOString(),
      },
      ConditionExpression: "attribute_not_exists(#version) OR #version < :version",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":version": version },
    }));
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
}

export async function handler(event: IoTEvent | Record<string, unknown>): Promise<{ status: string }> {
  const value = event as Record<string, unknown>;
  if ("event_id" in value && "temp_c" in value && "humidity" in value) {
    await saveTelemetry(value);
  } else if ("event_id" in value && "is_light_on" in value && "is_heater_on" in value) {
    await saveState(value);
  } else if ("current" in value && "timestamp" in value) {
    await saveShadow(value);
  } else {
    throw new Error("Unsupported IoT rule event");
  }
  return { status: "ok" };
}
