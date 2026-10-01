import {
  CognitoIdentityClient,
  GetCredentialsForIdentityCommand,
  GetIdCommand,
} from "@aws-sdk/client-cognito-identity";
import { AttachPolicyCommand, IoTClient } from "@aws-sdk/client-iot";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

const region = process.env.AWS_REGION;
const identityClient = new CognitoIdentityClient({ region });
const iotClient = new IoTClient({ region });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export async function handler(event: APIGatewayProxyEventV2) {
  const authorization = event.headers.authorization ?? event.headers.Authorization ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return { statusCode: 401, body: "missing token" };
  }

  const userPoolId = required("USER_POOL_ID");
  const identityPoolId = required("IDENTITY_POOL_ID");
  const provider = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  const logins = { [provider]: authorization.slice("Bearer ".length) };
  const identity = await identityClient.send(new GetIdCommand({
    IdentityPoolId: identityPoolId,
    Logins: logins,
  }));
  if (!identity.IdentityId) throw new Error("Cognito identity ID is missing");

  await iotClient.send(new AttachPolicyCommand({
    policyName: required("IOT_POLICY_NAME"),
    target: identity.IdentityId,
  }));
  const result = await identityClient.send(new GetCredentialsForIdentityCommand({
    IdentityId: identity.IdentityId,
    Logins: logins,
  }));
  const credentials = result.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretKey || !credentials.SessionToken || !credentials.Expiration) {
    throw new Error("Cognito identity credentials are missing");
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({
      endpoint: required("IOT_ENDPOINT"),
      region,
      identityId: identity.IdentityId,
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretKey,
      sessionToken: credentials.SessionToken,
      expiration: credentials.Expiration.toISOString(),
    }),
  };
}
