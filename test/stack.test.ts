import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ReptileIotStack } from "../lib/reptile-iot-stack";

describe("ReptileIot stack migration", () => {
  it("keeps the existing Cognito and device logical IDs while protecting light control", () => {
    const app = new App();
    const stack = new ReptileIotStack(app, "ReptileIot", {
      env: { account: "111111111111", region: "ap-northeast-1" },
      cognitoDomainPrefix: "reptile-migration-review",
      iotEndpoint: "example-ats.iot.ap-northeast-1.amazonaws.com",
    });
    const template = Template.fromStack(stack).toJSON();

    expect(template.Resources).toHaveProperty("ViewerUsers50362268");
    expect(template.Resources).toHaveProperty("ViewerIdentities");
    expect(template.Resources).toHaveProperty("SensorThing");
    expect(template.Resources).toHaveProperty("ControllerThing");
    expect(template.Resources).toHaveProperty("SensorCertificate");
    expect(template.Resources).toHaveProperty("ControllerCertificate");
    expect(template.Resources.ViewerUsers50362268).toMatchObject({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });

    const resources = template.Resources as Record<string, {
      Type: string;
      Properties?: Record<string, unknown>;
      DeletionPolicy?: string;
      UpdateReplacePolicy?: string;
    }>;
    const routes = Object.values(resources).filter((resource) => resource.Type === "AWS::ApiGatewayV2::Route");
    const lightRoute = routes.find((resource) => resource.Properties?.RouteKey === "POST /control/light");
    const historyRoute = routes.find((resource) => resource.Properties?.RouteKey === "GET /api/{proxy+}");
    expect(lightRoute?.Properties).toMatchObject({ AuthorizationType: "JWT" });
    expect(historyRoute?.Properties).toMatchObject({ AuthorizationType: "NONE" });
  });
});
