"""IoT devices, read-only browser sessions, and MQTT-to-HTTPS archival."""

from pathlib import Path

from aws_cdk import CfnOutput, CfnParameter, Duration, RemovalPolicy, Stack
from aws_cdk import aws_apigatewayv2 as apigw
from aws_cdk import aws_apigatewayv2_authorizers as authorizers
from aws_cdk import aws_apigatewayv2_integrations as integrations
from aws_cdk import aws_cognito as cognito
from aws_cdk import aws_iam as iam
from aws_cdk import aws_iot as iot
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_secretsmanager as secretsmanager
from constructs import Construct

TELEMETRY_TOPIC = "reptile/cage/telemetry"
STATE_TOPIC = "reptile/cage/state"


class ReptileIotStack(Stack):
    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        backend_base_url: str,
        web_base_url: str,
        cognito_domain_prefix: str,
        iot_endpoint: str,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)
        if not backend_base_url.startswith("https://"):
            raise ValueError("backendBaseUrl must be HTTPS")
        if not (web_base_url.startswith("https://") or web_base_url.startswith("http://localhost:")):
            raise ValueError("webBaseUrl must be HTTPS or localhost")
        backend = backend_base_url.rstrip("/")
        web = web_base_url.rstrip("/")
        callback_urls = [f"{web}/oauth2callback"]
        if web != "http://localhost:8501":
            callback_urls.append("http://localhost:8501/oauth2callback")

        def topic_arn(kind: str, name: str) -> str:
            return self.format_arn(service="iot", resource=kind, resource_name=name)

        user_pool = cognito.UserPool(
            self, "ViewerUsers",
            self_sign_up_enabled=False,
            sign_in_aliases=cognito.SignInAliases(email=True),
            standard_attributes=cognito.StandardAttributes(
                email=cognito.StandardAttribute(required=True, mutable=False)
            ),
            deletion_protection=True,
            removal_policy=RemovalPolicy.RETAIN,
        )
        user_client = user_pool.add_client(
            "StreamlitClient",
            generate_secret=True,
            prevent_user_existence_errors=True,
            o_auth=cognito.OAuthSettings(
                flows=cognito.OAuthFlows(authorization_code_grant=True),
                callback_urls=callback_urls,
                logout_urls=[web],
                scopes=[cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
            ),
        )
        user_pool.add_domain(
            "LoginDomain", cognito_domain=cognito.CognitoDomainOptions(domain_prefix=cognito_domain_prefix)
        )
        identity_pool = cognito.CfnIdentityPool(
            self, "ViewerIdentities",
            allow_unauthenticated_identities=False,
            cognito_identity_providers=[cognito.CfnIdentityPool.CognitoIdentityProviderProperty(
                client_id=user_client.user_pool_client_id,
                provider_name=user_pool.user_pool_provider_name,
                server_side_token_check=True,
            )],
        )
        web_role = iam.Role(
            self, "ViewerRole",
            assumed_by=iam.FederatedPrincipal(
                "cognito-identity.amazonaws.com",
                conditions={
                    "StringEquals": {"cognito-identity.amazonaws.com:aud": identity_pool.ref},
                    "ForAnyValue:StringLike": {"cognito-identity.amazonaws.com:amr": "authenticated"},
                },
                assume_role_action="sts:AssumeRoleWithWebIdentity",
            ),
        )
        web_permissions = [
            (["iot:Connect"], [topic_arn("client", "reptile-web-*")]),
            (["iot:Subscribe"], [topic_arn("topicfilter", TELEMETRY_TOPIC), topic_arn("topicfilter", STATE_TOPIC)]),
            (["iot:Receive"], [topic_arn("topic", TELEMETRY_TOPIC), topic_arn("topic", STATE_TOPIC)]),
        ]
        for actions, resources in web_permissions:
            web_role.add_to_policy(iam.PolicyStatement(actions=actions, resources=resources))
        cognito.CfnIdentityPoolRoleAttachment(
            self, "ViewerRoleAttachment",
            identity_pool_id=identity_pool.ref,
            roles={"authenticated": web_role.role_arn},
        )
        web_policy = iot.CfnPolicy(
            self, "WebReadOnlyPolicy",
            policy_name=f"{self.stack_name}-web-readonly",
            policy_document={
                "Version": "2012-10-17",
                "Statement": [
                    {"Effect": "Allow", "Action": actions, "Resource": resources}
                    for actions, resources in web_permissions
                ],
            },
        )

        session_function = lambda_.Function(
            self, "ViewerSession",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="session.handler",
            code=lambda_.Code.from_asset(str(Path(__file__).parent / "lambda")),
            timeout=Duration.seconds(15),
            environment={
                "IDENTITY_POOL_ID": identity_pool.ref,
                "USER_POOL_ID": user_pool.user_pool_id,
                "IOT_POLICY_NAME": web_policy.policy_name,
                "IOT_ENDPOINT": iot_endpoint,
            },
        )
        session_function.add_to_role_policy(iam.PolicyStatement(
            actions=["iot:AttachPolicy"], resources=[web_policy.attr_arn]
        ))
        session_function.add_to_role_policy(iam.PolicyStatement(
            actions=["cognito-identity:GetId", "cognito-identity:GetCredentialsForIdentity"],
            resources=["*"],
        ))
        api = apigw.HttpApi(self, "ViewerSessionApi")
        api.add_routes(
            path="/session",
            methods=[apigw.HttpMethod.POST],
            integration=integrations.HttpLambdaIntegration("SessionIntegration", session_function),
            authorizer=authorizers.HttpJwtAuthorizer(
                "ViewerJwt",
                f"https://cognito-idp.{self.region}.amazonaws.com/{user_pool.user_pool_id}",
                jwt_audience=[user_client.user_pool_client_id],
            ),
        )

        sensor_policy = iot.CfnPolicy(self, "SensorPolicy", policy_document={
            "Version": "2012-10-17", "Statement": [
                {"Effect": "Allow", "Action": "iot:Connect", "Resource": topic_arn("client", "reptile-sensor")},
                {"Effect": "Allow", "Action": ["iot:Publish", "iot:RetainPublish"],
                 "Resource": topic_arn("topic", TELEMETRY_TOPIC)},
            ],
        })
        controller_policy = iot.CfnPolicy(self, "ControllerPolicy", policy_document={
            "Version": "2012-10-17", "Statement": [
                {"Effect": "Allow", "Action": "iot:Connect", "Resource": topic_arn("client", "reptile-controller")},
                {"Effect": "Allow", "Action": "iot:Subscribe", "Resource": topic_arn("topicfilter", TELEMETRY_TOPIC)},
                {"Effect": "Allow", "Action": "iot:Receive", "Resource": topic_arn("topic", TELEMETRY_TOPIC)},
                {"Effect": "Allow", "Action": ["iot:Publish", "iot:RetainPublish"],
                 "Resource": topic_arn("topic", STATE_TOPIC)},
            ],
        })
        for name, policy in (("Sensor", sensor_policy), ("Controller", controller_policy)):
            thing = iot.CfnThing(self, f"{name}Thing", thing_name=f"reptile-{name.lower()}")
            csr = CfnParameter(self, f"{name}Csr", type="String", description=f"PEM CSR for {name.lower()} device")
            certificate = iot.CfnCertificate(
                self, f"{name}Certificate", certificate_signing_request=csr.value_as_string, status="ACTIVE"
            )
            certificate.apply_removal_policy(RemovalPolicy.RETAIN)
            iot.CfnThingPrincipalAttachment(
                self, f"{name}ThingCertificate", thing_name=thing.thing_name, principal=certificate.attr_arn
            )
            iot.CfnPolicyPrincipalAttachment(
                self, f"{name}PolicyCertificate", policy_name=policy.ref, principal=certificate.attr_arn
            )
            CfnOutput(self, f"{name}CertificateArn", value=certificate.attr_arn)

        ingest_secret = secretsmanager.Secret(
            self, "IngestKey",
            generate_secret_string=secretsmanager.SecretStringGenerator(
                secret_string_template="{}", generate_string_key="key", password_length=48
            ),
            removal_policy=RemovalPolicy.RETAIN,
        )
        secret_role = iam.Role(self, "IoTSecretReader", assumed_by=iam.ServicePrincipal("iot.amazonaws.com"))
        ingest_secret.grant_read(secret_role)
        failures = s3.Bucket(
            self, "RuleFailures",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            versioned=True,
            removal_policy=RemovalPolicy.RETAIN,
            lifecycle_rules=[s3.LifecycleRule(
                expiration=Duration.days(30), noncurrent_version_expiration=Duration.days(30)
            )],
        )
        failure_role = iam.Role(self, "IoTFailureWriter", assumed_by=iam.ServicePrincipal("iot.amazonaws.com"))
        failures.grant_put(failure_role)
        key_header = (
            "${get_secret('" + ingest_secret.secret_arn + "','SecretString','key','"
            + secret_role.role_arn + "')}"
        )
        for name, topic, endpoint in (
            ("Telemetry", TELEMETRY_TOPIC, "telemetry"),
            ("State", STATE_TOPIC, "state"),
        ):
            iot.CfnTopicRule(
                self, f"{name}Rule",
                rule_name=f"reptile_{endpoint}_to_backend",
                topic_rule_payload=iot.CfnTopicRule.TopicRulePayloadProperty(
                    sql=f"SELECT * FROM '{topic}'",
                    aws_iot_sql_version="2016-03-23",
                    rule_disabled=False,
                    actions=[iot.CfnTopicRule.ActionProperty(
                        http=iot.CfnTopicRule.HttpActionProperty(
                            url=f"{backend}/api/iot/{endpoint}",
                            confirmation_url=f"{backend}/api/iot",
                            headers=[iot.CfnTopicRule.HttpActionHeaderProperty(
                                key="X-IoT-Key", value=key_header
                            )],
                        ),
                    )],
                    error_action=iot.CfnTopicRule.ActionProperty(
                        s3=iot.CfnTopicRule.S3ActionProperty(
                            bucket_name=failures.bucket_name,
                            key=f"{endpoint}/${{timestamp()}}.json",
                            role_arn=failure_role.role_arn,
                        ),
                    ),
                ),
            )

        CfnOutput(self, "UserPoolId", value=user_pool.user_pool_id)
        CfnOutput(self, "UserPoolClientId", value=user_client.user_pool_client_id)
        CfnOutput(self, "IdentityPoolId", value=identity_pool.ref)
        CfnOutput(self, "CognitoDomain", value=f"{cognito_domain_prefix}.auth.{self.region}.amazoncognito.com")
        CfnOutput(self, "SessionUrl", value=f"{api.api_endpoint}/session")
        CfnOutput(self, "IngestSecretArn", value=ingest_secret.secret_arn)
        CfnOutput(self, "FailureBucket", value=failures.bucket_name)
