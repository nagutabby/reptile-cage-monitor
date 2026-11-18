import {
  DeleteThingShadowCommand,
  GetThingShadowCommand,
  IoTDataPlaneClient,
  PublishCommand,
  UpdateThingShadowCommand,
} from "@aws-sdk/client-iot-data-plane";
import { CreateTableCommand, DynamoDBClient, waitUntilTableExists } from "@aws-sdk/client-dynamodb";

// lib/reptile-cage-monitor-stack.ts の MonitorData テーブルと同じキー構成
export async function createMonitorTable(tableName: string): Promise<void> {
  const client = new DynamoDBClient({});
  await client.send(new CreateTableCommand({
    TableName: tableName,
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
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
}

// エミュレータの host:port。IoT Data Plane のエンドポイントとして Lambda に渡す
export function emulatorHost(): string {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (!endpoint) throw new Error("AWS_ENDPOINT_URL is not set; run via pnpm run test:integration");
  return new URL(endpoint).host;
}

export const CONTROLLER_THING = "reptile-cage-monitor-controller";
export const TELEMETRY_TOPIC = "reptile-cage-monitor/cage/telemetry";

const iotData = () => new IoTDataPlaneClient({});

export async function resetShadow(thingName = CONTROLLER_THING): Promise<void> {
  try {
    await iotData().send(new DeleteThingShadowCommand({ thingName }));
  } catch (error) {
    if (!(error instanceof Error && error.name === "ResourceNotFoundException")) throw error;
  }
}

export async function writeDesired(
  desired: Record<string, unknown>,
  thingName = CONTROLLER_THING,
): Promise<void> {
  await iotData().send(new UpdateThingShadowCommand({
    thingName,
    payload: Buffer.from(JSON.stringify({ state: { desired } })),
  }));
}

export async function readDesired(thingName = CONTROLLER_THING): Promise<Record<string, unknown>> {
  const response = await iotData().send(new GetThingShadowCommand({ thingName }));
  const document = JSON.parse(Buffer.from(response.payload as Uint8Array).toString());
  return document.state?.desired ?? {};
}

// ヒーター制御が読む retained メッセージを差し替える。null は retained メッセージの削除
export async function setRetainedTelemetry(payload: Record<string, unknown> | null): Promise<void> {
  await iotData().send(new PublishCommand({
    topic: TELEMETRY_TOPIC,
    retain: true,
    qos: 0,
    payload: payload === null ? new Uint8Array() : Buffer.from(JSON.stringify(payload)),
  }));
  // Docker 内のエミュレータの時計がホストより数十 ms 進むことがあり、直後に読むと lastModifiedTime が
  // 未来になって heater-control が「温度なし」と扱うため、少し待つ
  await new Promise((resolve) => setTimeout(resolve, 200));
}
