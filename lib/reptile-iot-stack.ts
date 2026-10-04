import path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as eventTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as iot from "aws-cdk-lib/aws-iot";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as ssm from "aws-cdk-lib/aws-ssm";

const TELEMETRY_TOPIC = "reptile/cage/telemetry";
const STATE_TOPIC = "reptile/cage/state";
const SHADOW_TOPIC = "$aws/things/reptile-controller/shadow";
const LAMBDA_RUNTIME = lambda.Runtime.NODEJS_24_X;

const recordNameWithinZone = (domainName: string, zoneName: string): string | undefined => {
  if (domainName === zoneName) return undefined;
  const suffix = `.${zoneName}`;
  if (!domainName.endsWith(suffix)) {
    throw new Error(`${domainName} is not within the Route 53 hosted zone ${zoneName}`);
  }
  return domainName.slice(0, -suffix.length);
};

export interface ReptileIotStackProps extends cdk.StackProps {
  readonly cognitoDomainPrefix: string;
  readonly iotEndpoint: string;
  /** Optional custom hostname for the CloudFront dashboard. */
  readonly dashboardDomainName?: string;
  /** ACM certificate ARN in us-east-1 for dashboardDomainName. */
  readonly dashboardCertificateArn?: string;
  /** Public Route 53 hosted zone containing dashboardDomainName. */
  readonly dashboardHostedZoneId?: string;
  readonly dashboardHostedZoneName?: string;
  /** Optional second hostname kept on the same CloudFront distribution. */
  readonly dashboardAdditionalDomainName?: string;
  readonly dashboardAdditionalHostedZoneId?: string;
  readonly dashboardAdditionalHostedZoneName?: string;
  /** Optional old site origin, for a short overlap period. */
  readonly legacyWebBaseUrl?: string;
  readonly lineTokenParameterName?: string;
  readonly lineToParameterName?: string;
}

export class ReptileIotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ReptileIotStackProps) {
    super(scope, id, props);

    const githubActionsProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GitHubActionsOIDCProvider",
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );
    const githubDeployRole = new iam.Role(this, "GitHubDeployRole", {
      roleName: "reptile-cage-monitor-github-deploy",
      description: "Allows the main branch of nagutabby/reptile-cage-monitor to deploy this CDK stack",
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(githubActionsProvider, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:nagutabby@62084485/reptile-cage-monitor@1390838113:ref:refs/heads/main",
        },
      }),
    });
    githubDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: [
        `arn:aws:iam::${this.account}:role/cdk-hnb659fds-deploy-role-${this.account}-${this.region}`,
        `arn:aws:iam::${this.account}:role/cdk-hnb659fds-file-publishing-role-${this.account}-${this.region}`,
        `arn:aws:iam::${this.account}:role/cdk-hnb659fds-lookup-role-${this.account}-${this.region}`,
      ],
    }));

    if (!props.iotEndpoint || props.iotEndpoint.includes("://")) {
      throw new Error("iotEndpoint must be an AWS IoT data ATS hostname");
    }
    const hasDashboardDomain = Boolean(props.dashboardDomainName);
    if (hasDashboardDomain !== Boolean(props.dashboardCertificateArn)
      || hasDashboardDomain !== Boolean(props.dashboardHostedZoneId)
      || hasDashboardDomain !== Boolean(props.dashboardHostedZoneName)
      || Boolean(props.dashboardAdditionalDomainName) !== Boolean(props.dashboardAdditionalHostedZoneId)
      || Boolean(props.dashboardAdditionalDomainName) !== Boolean(props.dashboardAdditionalHostedZoneName)
      || (props.dashboardAdditionalDomainName && !props.dashboardDomainName)) {
      throw new Error("dashboard domain, certificate, and hosted-zone settings must be provided consistently");
    }
    const topicArn = (kind: string, name: string) => this.formatArn({
      service: "iot",
      resource: kind,
      resourceName: name,
    });

    const userPool = new cognito.UserPool(this, "ViewerUsers", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const viewerEmail = new cdk.CfnParameter(this, "ViewerEmail", {
      type: "String",
      description: "Email address for the invited dashboard viewer",
    });
    new cognito.CfnUserPoolUser(this, "DashboardViewer", {
      userPoolId: userPool.userPoolId,
      username: viewerEmail.valueAsString,
      desiredDeliveryMediums: ["EMAIL"],
      userAttributes: [
        { name: "email", value: viewerEmail.valueAsString },
        { name: "email_verified", value: "true" },
      ],
    });

    // Keep this existing client and ID so the current Cognito setup remains addressable
    // during the cutover. The Astro client is a public PKCE client for browser login.
    const legacyClient = userPool.addClient("StreamlitClient", {
      generateSecret: true,
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        callbackUrls: props.legacyWebBaseUrl
          ? [`${props.legacyWebBaseUrl.replace(/\/$/, "")}/oauth2callback`, "http://localhost:8501/oauth2callback"]
          : ["http://localhost:8501/oauth2callback"],
        logoutUrls: [props.legacyWebBaseUrl?.replace(/\/$/, "") ?? "http://localhost:8501"],
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
      },
    });
    userPool.addDomain("LoginDomain", {
      cognitoDomain: { domainPrefix: props.cognitoDomainPrefix },
    });

    const identityPool = new cognito.CfnIdentityPool(this, "ViewerIdentities", {
      allowUnauthenticatedIdentities: true,
      cognitoIdentityProviders: [{
        clientId: legacyClient.userPoolClientId,
        providerName: userPool.userPoolProviderName,
        serverSideTokenCheck: true,
      }],
    });

    const webPermissions: Array<[string[], string[]]> = [
      [["iot:Connect"], [topicArn("client", "reptile-web-*")]],
      [["iot:Subscribe"], [topicArn("topicfilter", TELEMETRY_TOPIC), topicArn("topicfilter", STATE_TOPIC)]],
      [["iot:Receive"], [topicArn("topic", TELEMETRY_TOPIC), topicArn("topic", STATE_TOPIC)]],
    ];
    const viewerRole = new iam.Role(this, "ViewerRole", {
      assumedBy: new iam.FederatedPrincipal("cognito-identity.amazonaws.com", {
        "StringEquals": { "cognito-identity.amazonaws.com:aud": identityPool.ref },
        "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" },
      }, "sts:AssumeRoleWithWebIdentity"),
    });
    const guestRole = new iam.Role(this, "GuestViewerRole", {
      assumedBy: new iam.FederatedPrincipal("cognito-identity.amazonaws.com", {
        "StringEquals": { "cognito-identity.amazonaws.com:aud": identityPool.ref },
        "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "unauthenticated" },
      }, "sts:AssumeRoleWithWebIdentity"),
    });
    for (const role of [viewerRole, guestRole]) {
      for (const [actions, resources] of webPermissions) {
        role.addToPolicy(new iam.PolicyStatement({ actions, resources }));
      }
    }
    new cognito.CfnIdentityPoolRoleAttachment(this, "ViewerRoleAttachment", {
      identityPoolId: identityPool.ref,
      roles: { authenticated: viewerRole.roleArn, unauthenticated: guestRole.roleArn },
    });
    const webPolicy = new iot.CfnPolicy(this, "WebReadOnlyPolicy", {
      policyName: `${this.stackName}-web-readonly`,
      policyDocument: {
        Version: "2012-10-17",
        Statement: webPermissions.map(([actions, resources]) => ({ Effect: "Allow", Action: actions, Resource: resources })),
      },
    });

    const table = new dynamodb.Table(this, "MonitorData", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const siteBucket = new s3.Bucket(this, "DashboardSite", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const sessionFunction = new lambdaNodejs.NodejsFunction(this, "ViewerSession", {
      entry: path.join(__dirname, "..", "lambda", "session.ts"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      timeout: cdk.Duration.seconds(15),
      environment: {
        IDENTITY_POOL_ID: identityPool.ref,
        USER_POOL_ID: userPool.userPoolId,
        IOT_POLICY_NAME: `${this.stackName}-web-readonly`,
        IOT_ENDPOINT: props.iotEndpoint,
      },
      bundling: { minify: true, sourceMap: true, target: "node24" },
    });
    sessionFunction.addToRolePolicy(new iam.PolicyStatement({ actions: ["iot:AttachPolicy"], resources: ["*"] }));
    sessionFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["cognito-identity:GetId", "cognito-identity:GetCredentialsForIdentity"], resources: ["*"],
    }));

    const api = new apigwv2.HttpApi(this, "ViewerSessionApi", {
      ...(props.legacyWebBaseUrl ? { corsPreflight: {
        allowOrigins: [props.legacyWebBaseUrl.replace(/\/$/, "")],
        allowMethods: [apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.GET],
        allowHeaders: ["Authorization", "Content-Type"],
      } } : {}),
    });
    const astroClient = userPool.addClient("AstroClient", {
      generateSecret: false,
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        // Replaced with the generated CloudFront hostname after the distribution is created.
        callbackUrls: ["https://dashboard.invalid/oauth2callback"],
        logoutUrls: ["https://dashboard.invalid/"],
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
      },
    });
    // Astro's redirect/logout values are filled once the distribution's generated hostname is known.
    // Cognito app-client URLs accept CloudFormation tokens, so these are replaced below by a Cfn client
    // override after the distribution is created.

    const authorizer = new apigwv2Authorizers.HttpJwtAuthorizer(
      "ViewerJwt",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [legacyClient.userPoolClientId, astroClient.userPoolClientId] },
    );
    api.addRoutes({
      path: "/session",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration("SessionIntegration", sessionFunction),
      authorizer,
    });

    const lineTokenParameterName = props.lineTokenParameterName ?? "/reptile-monitor/line/channel-access-token";
    const lineToParameterName = props.lineToParameterName ?? "/reptile-monitor/line/to-id";
    const parameterArn = (name: string) => this.formatArn({
      service: "ssm", resource: "parameter", resourceName: name.replace(/^\/+/, ""),
    });
    const ingestFunction = new lambdaNodejs.NodejsFunction(this, "Ingest", {
      entry: path.join(__dirname, "..", "lambda", "ingest.ts"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: table.tableName,
        IOT_ENDPOINT: props.iotEndpoint,
        LINE_TOKEN_PARAMETER: lineTokenParameterName,
        LINE_TO_ID_PARAMETER: lineToParameterName,
      },
      bundling: { minify: true, sourceMap: true, target: "node24" },
    });
    table.grantReadWriteData(ingestFunction);
    ingestFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [parameterArn(lineTokenParameterName), parameterArn(lineToParameterName)],
    }));
    ingestFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
      resources: ["*"],
      conditions: { StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` } },
    }));

    const apiFunction = new lambdaNodejs.NodejsFunction(this, "LightControl", {
      entry: path.join(__dirname, "..", "lambda", "api.ts"),
      handler: "handler",
      runtime: LAMBDA_RUNTIME,
      timeout: cdk.Duration.seconds(15),
      environment: {
        TABLE_NAME: table.tableName,
        IOT_ENDPOINT: props.iotEndpoint,
        IDENTITY_POOL_ID: identityPool.ref,
        USER_POOL_ID: userPool.userPoolId,
        ASTRO_CLIENT_ID: astroClient.userPoolClientId,
        COGNITO_DOMAIN: `${props.cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com`,
      },
      bundling: { minify: true, sourceMap: true, target: "node24" },
    });
    table.grantReadData(apiFunction);
    apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["iot:GetThingShadow", "iot:UpdateThingShadow"],
      resources: [topicArn("thing", "reptile-controller")],
    }));
    new cloudwatch.Alarm(this, "LightControlFailures", {
      metric: apiFunction.metricErrors(), threshold: 1, evaluationPeriods: 1,
    });
    api.addRoutes({
      path: "/api/{proxy+}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration("DashboardApiIntegration", apiFunction),
    });
    api.addRoutes({
      path: "/control/light",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration("LightControlIntegration", apiFunction),
      authorizer,
    });

    const makeControlFunction = (constructId: string, entry: string, timeoutSeconds = 20) => {
      const fn = new lambdaNodejs.NodejsFunction(this, constructId, {
        entry: path.join(__dirname, "..", "lambda", entry),
        handler: "handler",
        runtime: LAMBDA_RUNTIME,
        timeout: cdk.Duration.seconds(timeoutSeconds),
        environment: { IOT_ENDPOINT: props.iotEndpoint },
        bundling: { minify: true, sourceMap: true, target: "node24" },
      });
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["iot:GetThingShadow", "iot:UpdateThingShadow"],
        resources: [topicArn("thing", "reptile-controller")],
      }));
      new cloudwatch.Alarm(this, `${constructId}Failures`, {
        metric: fn.metricErrors(), threshold: 1, evaluationPeriods: 1,
      });
      return fn;
    };

    const heaterControl = makeControlFunction("HeaterControl", "heater-control.ts");
    heaterControl.addToRolePolicy(new iam.PolicyStatement({
      actions: ["iot:GetRetainedMessage"], resources: [topicArn("topic", TELEMETRY_TOPIC)],
    }));
    new events.Rule(this, "HeaterControlSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new eventTargets.LambdaFunction(heaterControl)],
    });

    const lightSchedule = makeControlFunction("LightSchedule", "light-schedule.ts");
    const scheduleRole = new iam.Role(this, "LightScheduleRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    lightSchedule.grantInvoke(scheduleRole);
    for (const hour of [7, 19]) {
      new scheduler.CfnSchedule(this, `LightAt${hour}`, {
        scheduleExpression: `cron(0 ${hour} * * ? *)`,
        scheduleExpressionTimezone: "Asia/Tokyo",
        flexibleTimeWindow: { mode: "OFF" },
        target: {
          arn: lightSchedule.functionArn,
          roleArn: scheduleRole.roleArn,
          input: JSON.stringify({ hour }),
          retryPolicy: { maximumEventAgeInSeconds: 300, maximumRetryAttempts: 3 },
        },
      });
    }

    const sensorPolicy = new iot.CfnPolicy(this, "SensorPolicy", { policyDocument: {
      Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: "iot:Connect", Resource: topicArn("client", "reptile-sensor") },
        { Effect: "Allow", Action: ["iot:Publish", "iot:RetainPublish"], Resource: topicArn("topic", TELEMETRY_TOPIC) },
      ],
    } });
    const controllerPolicy = new iot.CfnPolicy(this, "ControllerPolicy", { policyDocument: {
      Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: "iot:Connect", Resource: topicArn("client", "reptile-controller") },
        { Effect: "Allow", Action: "iot:Subscribe", Resource: [
          topicArn("topicfilter", `${SHADOW_TOPIC}/get/accepted`),
          topicArn("topicfilter", `${SHADOW_TOPIC}/get/rejected`),
          topicArn("topicfilter", `${SHADOW_TOPIC}/update/delta`),
        ] },
        { Effect: "Allow", Action: "iot:Receive", Resource: [
          topicArn("topic", `${SHADOW_TOPIC}/get/accepted`),
          topicArn("topic", `${SHADOW_TOPIC}/get/rejected`),
          topicArn("topic", `${SHADOW_TOPIC}/update/delta`),
        ] },
        { Effect: "Allow", Action: ["iot:Publish", "iot:RetainPublish"], Resource: topicArn("topic", STATE_TOPIC) },
        { Effect: "Allow", Action: "iot:Publish", Resource: [
          topicArn("topic", `${SHADOW_TOPIC}/update`), topicArn("topic", `${SHADOW_TOPIC}/get`),
        ] },
      ],
    } });
    for (const [name, policy] of [["Sensor", sensorPolicy], ["Controller", controllerPolicy]] as const) {
      const thingName = `reptile-${name.toLowerCase()}`;
      const thing = new iot.CfnThing(this, `${name}Thing`, { thingName });
      const csr = new cdk.CfnParameter(this, `${name}Csr`, {
        type: "String", description: `PEM CSR for ${name.toLowerCase()} device`,
      });
      const certificate = new iot.CfnCertificate(this, `${name}Certificate`, {
        certificateSigningRequest: csr.valueAsString, status: "ACTIVE",
      });
      certificate.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
      new iot.CfnThingPrincipalAttachment(this, `${name}ThingCertificate`, {
        thingName, principal: certificate.attrArn,
      });
      new iot.CfnPolicyPrincipalAttachment(this, `${name}PolicyCertificate`, {
        policyName: policy.ref, principal: certificate.attrArn,
      });
      new cdk.CfnOutput(this, `${name}CertificateArn`, { value: certificate.attrArn });
    }

    const failures = new s3.Bucket(this, "RuleFailures", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: cdk.Duration.days(30), noncurrentVersionExpiration: cdk.Duration.days(30) }],
    });
    const failureRole = new iam.Role(this, "IoTFailureWriter", {
      assumedBy: new iam.ServicePrincipal("iot.amazonaws.com"),
    });
    failures.grantPut(failureRole);

    const ruleSpecs = [
      ["Telemetry", TELEMETRY_TOPIC, "telemetry"],
      ["State", STATE_TOPIC, "state"],
      ["Shadow", `${SHADOW_TOPIC}/update/documents`, "shadow"],
    ] as const;
    for (const [name, topic, endpoint] of ruleSpecs) {
      const ruleName = `reptile_${endpoint}_to_backend`;
      const rule = new iot.CfnTopicRule(this, `${name}Rule`, {
        ruleName,
        topicRulePayload: {
          sql: `SELECT * FROM '${topic}'`,
          awsIotSqlVersion: "2016-03-23",
          ruleDisabled: false,
          actions: [{ lambda: { functionArn: ingestFunction.functionArn } }],
          errorAction: { s3: {
            bucketName: failures.bucketName,
            key: `${endpoint}/\${timestamp()}.json`,
            roleArn: failureRole.roleArn,
          } },
        },
      });
      ingestFunction.addPermission(`${name}RuleInvoke`, {
        principal: new iam.ServicePrincipal("iot.amazonaws.com"),
        sourceAccount: this.account,
        sourceArn: this.formatArn({ service: "iot", resource: "rule", resourceName: ruleName }),
      });
      rule.node.addDependency(ingestFunction);
    }

    const apiHost = cdk.Fn.select(2, cdk.Fn.split("/", api.apiEndpoint));
    const dashboardCertificate = props.dashboardCertificateArn
      ? acm.Certificate.fromCertificateArn(this, "DashboardCertificate", props.dashboardCertificateArn)
      : undefined;
    const distribution = new cloudfront.Distribution(this, "DashboardDistribution", {
      ...(props.dashboardDomainName ? { domainNames: [
        props.dashboardDomainName,
        ...(props.dashboardAdditionalDomainName ? [props.dashboardAdditionalDomainName] : []),
      ] } : {}),
      ...(dashboardCertificate ? { certificate: dashboardCertificate } : {}),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        functionAssociations: [{
          function: new cloudfront.Function(this, "DashboardUriRewrite", {
            code: cloudfront.FunctionCode.fromInline(
              "function handler(event) { var r = event.request; if (r.uri === '/oauth2callback') r.uri = '/oauth2callback/index.html'; return r; }",
            ),
          }),
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      additionalBehaviors: {
        "/api/*": this.apiBehavior(apiHost),
        "/control/*": this.apiBehavior(apiHost),
        "/session": this.apiBehavior(apiHost),
      },
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableIpv6: true,
    });

    const astroClientResource = astroClient.node.defaultChild as cognito.CfnUserPoolClient;
    astroClientResource.addPropertyOverride("CallbackURLs", [
      `https://${distribution.distributionDomainName}/oauth2callback`,
      ...(props.dashboardDomainName ? [`https://${props.dashboardDomainName}/oauth2callback`] : []),
      ...(props.dashboardAdditionalDomainName ? [`https://${props.dashboardAdditionalDomainName}/oauth2callback`] : []),
    ]);
    astroClientResource.addPropertyOverride("LogoutURLs", [
      `https://${distribution.distributionDomainName}/`,
      ...(props.dashboardDomainName ? [`https://${props.dashboardDomainName}/`] : []),
      ...(props.dashboardAdditionalDomainName ? [`https://${props.dashboardAdditionalDomainName}/`] : []),
    ]);
    if (props.dashboardDomainName && props.dashboardHostedZoneId) {
      const dashboardZone = route53.HostedZone.fromHostedZoneAttributes(this, "DashboardZone", {
        zoneName: props.dashboardHostedZoneName!,
        hostedZoneId: props.dashboardHostedZoneId,
      });
      const dashboardTarget = route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution));
      const additionalZone = props.dashboardAdditionalDomainName && props.dashboardAdditionalHostedZoneId
        ? route53.HostedZone.fromHostedZoneAttributes(this, "DashboardAdditionalZone", {
          zoneName: props.dashboardAdditionalHostedZoneName!,
          hostedZoneId: props.dashboardAdditionalHostedZoneId,
        })
        : undefined;
      const additionalRecordName = props.dashboardAdditionalDomainName && props.dashboardAdditionalHostedZoneName
        ? recordNameWithinZone(props.dashboardAdditionalDomainName, props.dashboardAdditionalHostedZoneName)
        : recordNameWithinZone(props.dashboardDomainName, props.dashboardHostedZoneName!);
      new route53.ARecord(this, "DashboardAliasA", {
        zone: additionalZone ?? dashboardZone,
        recordName: additionalRecordName,
        target: dashboardTarget,
      });
      new route53.AaaaRecord(this, "DashboardAliasAAAA", {
        zone: additionalZone ?? dashboardZone,
        recordName: additionalRecordName,
        target: dashboardTarget,
      });
      if (additionalZone) {
        const primaryRecordName = recordNameWithinZone(props.dashboardDomainName, props.dashboardHostedZoneName!);
        new route53.ARecord(this, "DashboardAliasA2", {
          zone: dashboardZone,
          recordName: primaryRecordName,
          target: dashboardTarget,
        });
        new route53.AaaaRecord(this, "DashboardAliasAAAA2", {
          zone: dashboardZone,
          recordName: primaryRecordName,
          target: dashboardTarget,
        });
      }
    }
    identityPool.cognitoIdentityProviders = [legacyClient, astroClient].map((client) => ({
      clientId: client.userPoolClientId,
      providerName: userPool.userPoolProviderName,
      serverSideTokenCheck: true,
    }));

    new s3deploy.BucketDeployment(this, "DashboardAssets", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "..", "frontend", "site", "dist"))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
      prune: true,
    });

    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: legacyClient.userPoolClientId });
    new cdk.CfnOutput(this, "AstroClientId", { value: astroClient.userPoolClientId });
    new cdk.CfnOutput(this, "LegacyUserPoolClientId", { value: legacyClient.userPoolClientId });
    new cdk.CfnOutput(this, "IdentityPoolId", { value: identityPool.ref });
    new cdk.CfnOutput(this, "CognitoDomain", { value: `${props.cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com` });
    new cdk.CfnOutput(this, "DashboardUrl", { value: `https://${distribution.distributionDomainName}` });
    if (props.dashboardDomainName) {
      new cdk.CfnOutput(this, "DashboardCustomUrl", { value: `https://${props.dashboardDomainName}` });
    }
    if (props.dashboardAdditionalDomainName) {
      new cdk.CfnOutput(this, "DashboardAdditionalUrl", { value: `https://${props.dashboardAdditionalDomainName}` });
    }
    new cdk.CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new cdk.CfnOutput(this, "SessionUrl", { value: `${api.apiEndpoint}/session` });
    new cdk.CfnOutput(this, "LightControlUrl", { value: `${api.apiEndpoint}/control/light` });
    new cdk.CfnOutput(this, "ReadingsTableName", { value: table.tableName });
    new cdk.CfnOutput(this, "LineTokenParameter", { value: lineTokenParameterName });
    new cdk.CfnOutput(this, "LineToParameter", { value: lineToParameterName });
    new cdk.CfnOutput(this, "FailureBucket", { value: failures.bucketName });
  }

  private apiBehavior(domainName: string): cloudfront.BehaviorOptions {
    return {
      origin: new origins.HttpOrigin(domainName, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      compress: true,
    };
  }
}
