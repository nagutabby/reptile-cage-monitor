import {
  CognitoIdentityClient,
  CreateIdentityPoolCommand,
  SetIdentityPoolRolesCommand,
} from "@aws-sdk/client-cognito-identity";
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreatePolicyCommand, IoTClient, ListAttachedPoliciesCommand } from "@aws-sdk/client-iot";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeAll, describe, expect, it } from "vitest";
import { emulatorHost } from "./helpers";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const PASSWORD = "Passw0rd!integration";
const POLICY_NAME = "integration-viewer-policy";

const idp = new CognitoIdentityProviderClient({});
const identity = new CognitoIdentityClient({});

type Session = typeof import("../../lambda/session");
let session: Session;
let userPoolId: string;
let clientId: string;
let idToken: string;

async function createPoolWithUser(name: string, username: string) {
  const pool = await idp.send(new CreateUserPoolCommand({ PoolName: name }));
  const poolId = pool.UserPool?.Id as string;
  const client = await idp.send(new CreateUserPoolClientCommand({
    UserPoolId: poolId,
    ClientName: `${name}-client`,
    ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
  }));
  const id = client.UserPoolClient?.ClientId as string;
  await idp.send(new AdminCreateUserCommand({ UserPoolId: poolId, Username: username, MessageAction: "SUPPRESS" }));
  await idp.send(new AdminSetUserPasswordCommand({
    UserPoolId: poolId, Username: username, Password: PASSWORD, Permanent: true,
  }));
  const auth = await idp.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: id,
    AuthParameters: { USERNAME: username, PASSWORD },
  }));
  return { poolId, clientId: id, idToken: auth.AuthenticationResult?.IdToken as string };
}

function request(authorization?: string): APIGatewayProxyEventV2 {
  return { headers: authorization === undefined ? {} : { authorization } } as unknown as APIGatewayProxyEventV2;
}

beforeAll(async () => {
  // lib/reptile-cage-monitor-stack.ts の ViewerUsers / ViewerIdentities / ViewerRole 相当を作る
  const viewer = await createPoolWithUser("integration-viewers", "viewer@example.com");
  userPoolId = viewer.poolId;
  clientId = viewer.clientId;
  idToken = viewer.idToken;

  const identityPool = await identity.send(new CreateIdentityPoolCommand({
    IdentityPoolName: "integration_identities",
    AllowUnauthenticatedIdentities: false,
    CognitoIdentityProviders: [{
      ProviderName: `cognito-idp.${REGION}.amazonaws.com/${userPoolId}`,
      ClientId: clientId,
    }],
  }));
  const identityPoolId = identityPool.IdentityPoolId as string;

  const role = await new IAMClient({}).send(new CreateRoleCommand({
    RoleName: "integration-viewer-role",
    AssumeRolePolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Federated: "cognito-identity.amazonaws.com" },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: { "cognito-identity.amazonaws.com:aud": identityPoolId },
          "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" },
        },
      }],
    }),
  }));
  await identity.send(new SetIdentityPoolRolesCommand({
    IdentityPoolId: identityPoolId,
    Roles: { authenticated: role.Role?.Arn as string },
  }));

  await new IoTClient({}).send(new CreatePolicyCommand({
    policyName: POLICY_NAME,
    policyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "iot:Connect", Resource: "*" }],
    }),
  }));

  process.env.USER_POOL_ID = userPoolId;
  process.env.IDENTITY_POOL_ID = identityPoolId;
  process.env.IOT_POLICY_NAME = POLICY_NAME;
  process.env.IOT_ENDPOINT = emulatorHost();
  session = await import("../../lambda/session");
});

describe("session handler against AWS Emulator (Cognito)", () => {
  it("issues an ID token whose audience is the app client the API authorizer expects", () => {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
    expect(payload).toMatchObject({ aud: clientId, token_use: "id" });
  });

  it("rejects a request without a bearer token", async () => {
    expect(await session.handler(request())).toMatchObject({ statusCode: 401 });
    expect(await session.handler(request("Basic abc"))).toMatchObject({ statusCode: 401 });
  });

  it("exchanges a valid ID token for IoT credentials and attaches the IoT policy", async () => {
    const response = await session.handler(request(`Bearer ${idToken}`)) as {
      statusCode: number;
      headers: Record<string, string>;
      body: string;
    };
    expect(response.statusCode).toBe(200);
    expect(response.headers["Cache-Control"]).toBe("no-store");

    const body = JSON.parse(response.body);
    expect(body).toMatchObject({ endpoint: emulatorHost(), region: REGION });
    expect(body.identityId).toMatch(new RegExp(`^${REGION}:`));
    expect(body.accessKeyId).toBeTruthy();
    expect(body.secretAccessKey).toBeTruthy();
    expect(body.sessionToken).toBeTruthy();
    expect(new Date(body.expiration).getTime()).toBeGreaterThan(Date.now());

    const attached = await new IoTClient({}).send(new ListAttachedPoliciesCommand({ target: body.identityId }));
    expect(attached.policies?.map((policy) => policy.policyName)).toEqual([POLICY_NAME]);
  });

  it("returns the same identity for the same user on repeated sign-ins", async () => {
    const first = JSON.parse(((await session.handler(request(`Bearer ${idToken}`))) as { body: string }).body);
    const second = JSON.parse(((await session.handler(request(`Bearer ${idToken}`))) as { body: string }).body);
    expect(second.identityId).toBe(first.identityId);
  });

  it("rejects a malformed token", async () => {
    await expect(session.handler(request("Bearer not-a-jwt"))).rejects.toMatchObject({
      name: "NotAuthorizedException",
    });
  });

  it("rejects a token issued by a different user pool", async () => {
    const stranger = await createPoolWithUser("integration-strangers", "stranger@example.com");
    await expect(session.handler(request(`Bearer ${stranger.idToken}`))).rejects.toMatchObject({
      name: "NotAuthorizedException",
    });
  });
});
