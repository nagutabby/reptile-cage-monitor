#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ReptileIotStack } from "../lib/reptile-iot-stack";

const app = new cdk.App();
const optionalContext = (key: string): string | undefined => {
  const value = app.node.tryGetContext(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
};
const dashboardDomainName = optionalContext("dashboardDomainName");
const dashboardCertificateArn = optionalContext("dashboardCertificateArn");
const dashboardHostedZoneId = optionalContext("dashboardHostedZoneId");
const dashboardHostedZoneName = optionalContext("dashboardHostedZoneName");
const dashboardAdditionalDomainName = optionalContext("dashboardAdditionalDomainName");
const dashboardAdditionalHostedZoneName = optionalContext("dashboardAdditionalHostedZoneName");
const dashboardAdditionalHostedZoneId = optionalContext("dashboardAdditionalHostedZoneId");
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
  ...(dashboardDomainName ? { dashboardDomainName } : {}),
  ...(dashboardCertificateArn ? { dashboardCertificateArn } : {}),
  ...(dashboardHostedZoneId ? { dashboardHostedZoneId } : {}),
  ...(dashboardHostedZoneName ? { dashboardHostedZoneName } : {}),
  ...(dashboardAdditionalDomainName ? { dashboardAdditionalDomainName } : {}),
  ...(dashboardAdditionalHostedZoneName ? { dashboardAdditionalHostedZoneName } : {}),
  ...(dashboardAdditionalHostedZoneId ? { dashboardAdditionalHostedZoneId } : {}),
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
