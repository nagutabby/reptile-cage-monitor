import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const TABLE_NAME = process.env.TABLE_NAME ?? "";

export function requireTableName(): string {
  if (!TABLE_NAME) throw new Error("Missing TABLE_NAME environment variable");
  return TABLE_NAME;
}

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: process.env.AWS_REGION,
}), {
  marshallOptions: { removeUndefinedValues: true },
});
