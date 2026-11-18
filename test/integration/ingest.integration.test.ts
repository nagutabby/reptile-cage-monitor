import { CreateTableCommand, DynamoDBClient, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, describe, expect, it } from "vitest";

const TABLE_NAME = "integration-monitor-data";

type Ingest = typeof import("../../lambda/ingest");
type Database = typeof import("../../lambda/database");
let ingest: Ingest;
let ddb: Database["ddb"];

beforeAll(async () => {
  // lambda/database.ts は import 時に TABLE_NAME を読むため、先に設定してから読み込む
  process.env.TABLE_NAME = TABLE_NAME;
  ingest = await import("../../lambda/ingest");
  ({ ddb } = await import("../../lambda/database"));

  const admin = new DynamoDBClient({});
  await admin.send(new CreateTableCommand({
    TableName: TABLE_NAME,
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  }));
  // CreateTable 直後は CREATING のため、ACTIVE になるまで待つ
  await waitUntilTableExists({ client: admin, maxWaitTime: 30 }, { TableName: TABLE_NAME });
});

const reading = (eventId: string, observedAt: string, tempC: number, humidity: number) => ({
  event_id: eventId,
  observed_at: observedAt,
  temp_c: tempC,
  humidity,
});

describe("ingest handler against AWS Emulator", () => {
  it("stores a reading and the latest state", async () => {
    await ingest.handler(reading("a1", "2026-10-07T00:00:00Z", 27, 50));

    const readings = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "READINGS" },
    }));
    expect(readings.Items).toHaveLength(1);
    expect(readings.Items?.[0]).toMatchObject({
      sk: "R#2026-10-07T00:00:00Z#a1",
      temp_c: 27,
      humidity: 50,
      recorded_at: "2026-10-07T00:00:00+00:00",
    });

    const latest = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: "STATE", sk: "LATEST" } }));
    expect(latest.Item).toMatchObject({ temp_c: 27, humidity: 50 });

    const alert = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: "ALERT", sk: "ENVIRONMENT" } }));
    expect(alert.Item).toMatchObject({ is_abnormal: false, evaluated_at: "2026-10-07T00:00:00Z" });
  });

  it("ignores a duplicate event id without failing", async () => {
    await ingest.handler(reading("a1", "2026-10-07T00:00:00Z", 28, 55));

    const readings = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "READINGS" },
    }));
    expect(readings.Items).toHaveLength(1);
    expect(readings.Items?.[0]).toMatchObject({ temp_c: 27 });
  });

  it("keeps the newest latest state when an older reading arrives late", async () => {
    await ingest.handler(reading("b2", "2026-10-07T00:10:00Z", 30, 60));
    await ingest.handler(reading("b1", "2026-10-07T00:05:00Z", 25, 45));

    const latest = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: "STATE", sk: "LATEST" } }));
    expect(latest.Item).toMatchObject({
      temp_c: 30,
      humidity: 60,
      recorded_at: "2026-10-07T00:10:00+00:00",
    });
  });

  it("only keeps the newest device state", async () => {
    const state = (eventId: string, observedAt: string, light: boolean) => ({
      event_id: eventId,
      observed_at: observedAt,
      is_light_on: light,
      is_heater_on: false,
    });
    await ingest.handler(state("s2", "2026-10-07T01:00:00Z", true));
    await ingest.handler(state("s1", "2026-10-07T00:30:00Z", false));

    const device = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: "STATE", sk: "DEVICE" } }));
    expect(device.Item).toMatchObject({ is_light_on: true, event_id: "s2" });
  });
});
