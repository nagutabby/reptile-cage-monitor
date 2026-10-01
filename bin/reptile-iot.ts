#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ReptileIotStack } from "../lib/reptile-iot-stack";

const app = new cdk.App();
const context = (key: string): string => {
  const value = app.node.tryGetContext(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing CDK context: ${key}`);
  }
  return value;
};

new ReptileIotStack(app, "ReptileIot", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "ap-northeast-1",
  },
  terminationProtection: true,
  cognitoDomainPrefix: context("cognitoDomainPrefix"),
  iotEndpoint: context("iotEndpoint"),
  ...(app.node.tryGetContext("legacyWebBaseUrl")
    ? { legacyWebBaseUrl: context("legacyWebBaseUrl") }
    : {}),
  ...(app.node.tryGetContext("lineTokenParameterName")
    ? { lineTokenParameterName: context("lineTokenParameterName") }
    : {}),
  ...(app.node.tryGetContext("lineToParameterName")
    ? { lineToParameterName: context("lineToParameterName") }
    : {}),
});
