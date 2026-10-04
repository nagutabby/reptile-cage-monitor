import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ReptileCageMonitorStack } from "../lib/reptile-cage-monitor-stack";

describe("ReptileCageMonitor stack", () => {
  it("uses the project identifiers for IoT, LINE settings, and authenticated light control", () => {
    const app = new App();
    const stack = new ReptileCageMonitorStack(app, "ReptileCageMonitor", {
      env: { account: "111111111111", region: "ap-northeast-1" },
      cognitoDomainPrefix: "reptile-cage-monitor-review",
      iotEndpoint: "example-ats.iot.ap-northeast-1.amazonaws.com",
    });
    const template = Template.fromStack(stack).toJSON();

    Template.fromStack(stack).hasResourceProperties("AWS::IoT::Thing", {
      ThingName: "reptile-cage-monitor-sensor",
    });
    Template.fromStack(stack).hasResourceProperties("AWS::IoT::Thing", {
      ThingName: "reptile-cage-monitor-controller",
    });

    const resources = template.Resources as Record<string, {
      Type: string;
      Properties?: Record<string, unknown>;
      DeletionPolicy?: string;
      UpdateReplacePolicy?: string;
    }>;
    const userPool = Object.values(resources).find((resource) => resource.Type === "AWS::Cognito::UserPool");
    expect(userPool).toMatchObject({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
    const policies = Object.values(resources)
      .filter((resource) => resource.Type === "AWS::IoT::Policy")
      .map((resource) => JSON.stringify(resource.Properties?.PolicyDocument));
    expect(policies.join(" ")).toContain("reptile-cage-monitor-sensor");
    expect(policies.join(" ")).toContain("reptile-cage-monitor-controller");
    expect(policies.join(" ")).toContain("reptile-cage-monitor/cage/telemetry");
    expect(policies.join(" ")).toContain("reptile-cage-monitor/cage/state");
    expect(policies.join(" ")).toContain("$aws/things/reptile-cage-monitor-controller/shadow");
    expect(JSON.stringify(template)).toContain("/reptile-cage-monitor/line/channel-access-token");
    expect(JSON.stringify(template)).toContain("/reptile-cage-monitor/line/to-id");

    const routes = Object.values(resources).filter((resource) => resource.Type === "AWS::ApiGatewayV2::Route");
    const lightRoute = routes.find((resource) => resource.Properties?.RouteKey === "POST /control/light");
    const historyRoute = routes.find((resource) => resource.Properties?.RouteKey === "GET /api/{proxy+}");
    expect(lightRoute?.Properties).toMatchObject({ AuthorizationType: "JWT" });
    expect(historyRoute?.Properties).toMatchObject({ AuthorizationType: "NONE" });
  });
});
