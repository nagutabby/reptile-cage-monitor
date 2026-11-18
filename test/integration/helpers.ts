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
