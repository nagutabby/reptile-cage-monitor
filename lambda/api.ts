import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Hono } from "hono";
import { handle } from "@hono/aws-lambda";
import { ddb, requireTableName } from "./database";
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
  getDeviceState(): Promise<Record<string, unknown>>;
  setLight(isLightOn: boolean): Promise<unknown>;
  getPublicConfig(): Record<string, string>;
}

export function createApi(dependencies: ApiDependencies): Hono {
  const app = new Hono();

  app.get("/healthz", (context) => context.json({ status: "ok" }));

  app.get("/api/config", (context) => context.json(dependencies.getPublicConfig(), 200, {
    "Cache-Control": "public, max-age=300",
  }));

  app.get("/api/readings", async (context) => {
    const rawMinutes = context.req.query("minutes");
    const minutes = rawMinutes === undefined ? 360 : Number(rawMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_080) {
      return context.json({ error: "minutes must be between 1 and 10080" }, 400);
    }
    return context.json(await dependencies.listReadings(minutes));
  });

  app.get("/api/device_state", async (context) => {
    return context.json(await dependencies.getDeviceState());
  });

  app.post("/control/light", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid JSON body" }, 400);
    }
    if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).is_light_on !== "boolean") {
      return context.json({ error: "is_light_on must be boolean" }, 400);
    }
    return context.json(await dependencies.setLight((body as { is_light_on: boolean }).is_light_on));
  });

  return app;
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

async function getDeviceState(): Promise<Record<string, unknown>> {
  const result = await ddb.send(new GetCommand({
    TableName: requireTableName(),
    Key: { pk: "STATE", sk: "DEVICE" },
  }));
  const item = result.Item;
  return {
    is_light_on: item?.is_light_on ?? null,
    is_light_on_changed_at: item?.is_light_on_changed_at ?? item?.reported_at ?? null,
    is_heater_on: item?.is_heater_on ?? null,
    is_heater_on_changed_at: item?.is_heater_on_changed_at ?? item?.reported_at ?? null,
  };
}

export const app = createApi({
  listReadings,
  getDeviceState,
  setLight,
  getPublicConfig: () => ({
    region: process.env.AWS_REGION ?? "ap-northeast-1",
    endpoint: required("IOT_ENDPOINT"),
    identityPoolId: required("IDENTITY_POOL_ID"),
    userPoolId: required("USER_POOL_ID"),
    clientId: required("ASTRO_CLIENT_ID"),
    cognitoDomain: required("COGNITO_DOMAIN"),
  }),
});
export const handler = handle(app);

export { isoSeconds };

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
