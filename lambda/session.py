"""Issue read-only IoT credentials to a user authenticated by API Gateway JWT auth."""

import json
import os

import boto3


def handler(event, context):
    authorization = event.get("headers", {}).get("authorization", "")
    if not authorization.startswith("Bearer "):
        return {"statusCode": 401, "body": "missing token"}
    id_token = authorization.removeprefix("Bearer ")
    region = os.environ["AWS_REGION"]
    provider = f"cognito-idp.{region}.amazonaws.com/{os.environ['USER_POOL_ID']}"
    logins = {provider: id_token}
    identity = boto3.client("cognito-identity", region_name=region)
    identity_id = identity.get_id(IdentityPoolId=os.environ["IDENTITY_POOL_ID"], Logins=logins)["IdentityId"]
    boto3.client("iot", region_name=region).attach_policy(
        policyName=os.environ["IOT_POLICY_NAME"], target=identity_id
    )
    credentials = identity.get_credentials_for_identity(IdentityId=identity_id, Logins=logins)["Credentials"]
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
        "body": json.dumps({
            "endpoint": os.environ["IOT_ENDPOINT"],
            "region": region,
            "identityId": identity_id,
            "accessKeyId": credentials["AccessKeyId"],
            "secretAccessKey": credentials["SecretKey"],
            "sessionToken": credentials["SessionToken"],
            "expiration": credentials["Expiration"].isoformat(),
        }),
    }
