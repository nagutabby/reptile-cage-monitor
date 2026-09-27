import mqtt from "mqtt";
import { CognitoIdentityClient, GetCredentialsForIdentityCommand, GetIdCommand } from "@aws-sdk/client-cognito-identity";

const encoder = new TextEncoder();
const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (value) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

async function hmac(key, value) {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(value)));
}

export async function signedUrl(config) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const date = stamp.slice(0, 8);
  const scope = `${date}/${config.region}/iotdevicegateway/aws4_request`;
  const parameters = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": "300",
    "X-Amz-SignedHeaders": "host",
  });
  const query = Array.from(parameters.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const canonical = `GET\n/mqtt\n${query}\nhost:${config.endpoint}\n\nhost\n${await sha256("")}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${await sha256(canonical)}`;
  let key = await hmac(encoder.encode(`AWS4${config.secretAccessKey}`), date);
  key = await hmac(key, config.region);
  key = await hmac(key, "iotdevicegateway");
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));
  return `wss://${config.endpoint}/mqtt?${query}&X-Amz-Signature=${signature}&X-Amz-Security-Token=${encodeURIComponent(config.sessionToken)}`;
}

export async function start(config) {
  const setText = (id, value) => { document.getElementById(id).textContent = value; };
  const identityClient = new CognitoIdentityClient({ region: config.region });
  let identityId;
  let client;
  let stopped = false;

  async function connect() {
    if (stopped) return;
    try {
      if (!identityId) {
        identityId = (await identityClient.send(new GetIdCommand({ IdentityPoolId: config.identityPoolId }))).IdentityId;
      }
      if (!identityId) throw new Error("Cognito identity ID is missing");
      const response = await identityClient.send(new GetCredentialsForIdentityCommand({ IdentityId: identityId }));
      const credentials = response.Credentials;
      if (!credentials?.AccessKeyId || !credentials?.SecretKey || !credentials?.SessionToken) {
        throw new Error("Cognito guest credentials are missing");
      }
      const url = await signedUrl({
        ...config,
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretKey,
        sessionToken: credentials.SessionToken,
      });
      client = mqtt.connect(url, {
        clientId: `reptile-web-${identityId.replace(/[^A-Za-z0-9]/g, "")}-${crypto.randomUUID().slice(0, 8)}`,
        protocolVersion: 4,
        reconnectPeriod: 0,
        connectTimeout: 10000,
      });
      client.on("connect", () => {
        client.subscribe(["reptile/cage/telemetry", "reptile/cage/state"], { qos: 1 });
      });
      client.on("message", (topic, bytes) => {
        try {
          const data = JSON.parse(bytes.toString());
          if (topic.endsWith("/telemetry")) {
            const age = Date.now() - Date.parse(data.observed_at);
            if (!Number.isFinite(age) || age < 0 || age > 120000) return;
            setText("temperature", `${Number(data.temp_c).toFixed(1)} ℃`);
            setText("humidity", `${Number(data.humidity).toFixed(0)} %`);
            setText("updated", `AWS IoT Coreと最後に同期した時刻: ${new Date(data.observed_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`);
          } else if (topic.endsWith("/state")) {
            setText("light", data.is_light_on ? "ON" : "OFF");
            setText("heater", data.is_heater_on ? "ON" : "OFF");
          }
        } catch (error) {
          console.warn("Invalid IoT payload", error);
        }
      });
      client.on("close", () => {
        if (!stopped) setTimeout(connect, 5000);
      });
      client.on("error", (error) => console.warn("MQTT error", error));
    } catch (error) {
      console.warn("IoT connection error", error);
      if (!stopped) setTimeout(connect, 5000);
    }
  }

  window.addEventListener("beforeunload", () => { stopped = true; client?.end(true); });
  await connect();
}
