"""CDK entry point. AWS resources are created only by an explicit cdk deploy."""

import os

import aws_cdk as cdk

from reptile_iot_stack import ReptileIotStack


app = cdk.App()


def context(key: str) -> str:
    value = app.node.try_get_context(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"Missing CDK context: {key}")
    return value


ReptileIotStack(
    app,
    "ReptileIot",
    env=cdk.Environment(
        account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
        region="ap-northeast-1",
    ),
    termination_protection=True,
    backend_base_url=context("backendBaseUrl"),
    web_base_url=context("webBaseUrl"),
    cognito_domain_prefix=context("cognitoDomainPrefix"),
    iot_endpoint=context("iotEndpoint"),
)

app.synth()
