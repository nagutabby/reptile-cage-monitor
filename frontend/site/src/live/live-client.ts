import mqtt, { type MqttClient } from "mqtt";
import { CognitoIdentityClient, GetCredentialsForIdentityCommand, GetIdCommand } from "@aws-sdk/client-cognito-identity";
import { apiClient } from "../api-client";
import type { AirConditionerSettings } from "../../../../lambda/api";

export interface LiveClientConfig {
  region: string;
  endpoint: string;
  identityPoolId: string;
  auth?: {
    token: string;
  };
}

interface SignedUrlConfig extends LiveClientConfig {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

interface TelemetryPayload {
  observed_at: string;
  temp_c: number;
  humidity: number;
}

interface AirConditionerEvent {
  command_id: string;
  status: "sent" | "failed";
}

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer | Uint8Array<ArrayBuffer>): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmac(key: BufferSource, value: string): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(value)));
}

export async function signedUrl(config: SignedUrlConfig): Promise<string> {
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
  let signingKey = await hmac(encoder.encode(`AWS4${config.secretAccessKey}`), date);
  signingKey = await hmac(signingKey, config.region);
  signingKey = await hmac(signingKey, "iotdevicegateway");
  signingKey = await hmac(signingKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  return `wss://${config.endpoint}/mqtt?${query}&X-Amz-Signature=${signature}&X-Amz-Security-Token=${encodeURIComponent(config.sessionToken)}`;
}

export async function start(config: LiveClientConfig): Promise<void> {
  const setText = (id: string, value: string): void => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  };
  const airPower = document.querySelector<HTMLSelectElement>("#ac-power");
  const airMode = document.querySelector<HTMLSelectElement>("#ac-mode");
  const airTemp = document.querySelector<HTMLInputElement>("#ac-temp");
  const airFan = document.querySelector<HTMLSelectElement>("#ac-fan");
  const airSwingV = document.querySelector<HTMLSelectElement>("#ac-swing-v");
  const airSendButton = document.querySelector<HTMLButtonElement>("#air-conditioner-send");
  const airAvailability = document.querySelector<HTMLElement>("#ac-availability");
  const airForm = document.querySelector<HTMLFormElement>("#air-conditioner-form");
  let airRequestInFlight = false;
  let activeAirCommandId: string | null = null;
  let airCommandTimeout: ReturnType<typeof setTimeout> | undefined;
  const receivedAirResults = new Map<string, AirConditionerEvent>();

  function currentAirSettings(): AirConditionerSettings | null {
    const power = airPower?.value;
    const mode = airMode?.value;
    const temp = Number(airTemp?.value);
    const fan = airFan?.value;
    const swingV = airSwingV?.value;
    if ((power !== "on" && power !== "off") || (mode !== "cool" && mode !== "heat") || !Number.isFinite(temp)
      || !Number.isInteger(temp * 2) || temp < 10 || temp > 32
      || (mode === "cool" && temp < 18) || !fan || !swingV) return null;
    return {
      power: power === "on",
      mode,
      temp_c: temp,
      fan: fan as AirConditionerSettings["fan"],
      swing_v: swingV as AirConditionerSettings["swing_v"],
    };
  }

  function updateAirConditionerForm(): void {
    if (!airMode || !airTemp || !airSendButton) return;
    airTemp.min = airMode.value === "cool" ? "18" : "10";
    if (airMode.value === "cool" && Number(airTemp.value) < 18) airTemp.value = "18";
    const loggedIn = Boolean(config.auth?.token);
    const valid = currentAirSettings() !== null;
    if (airAvailability) {
      airAvailability.textContent = !loggedIn ? "ログインするとエアコンを操作できます"
        : valid ? "" : "温度を入力してください";
    }
    airSendButton.disabled = !loggedIn || !valid || airRequestInFlight || activeAirCommandId !== null;
  }

  function validAirEvent(value: Record<string, unknown>): AirConditionerEvent | null {
    if (typeof value.command_id !== "string" || (value.status !== "sent" && value.status !== "failed")) return null;
    return { command_id: value.command_id, status: value.status };
  }

  function handleAirConditionerEvent(event: AirConditionerEvent): void {
    receivedAirResults.set(event.command_id, event);
    if (receivedAirResults.size > 8) {
      const oldest = receivedAirResults.keys().next().value;
      if (oldest) receivedAirResults.delete(oldest);
    }
    if (activeAirCommandId !== event.command_id) return;
    clearTimeout(airCommandTimeout);
    activeAirCommandId = null;
    setText("air-conditioner-control-status", event.status === "sent"
      ? "IR信号を送信しました（エアコン本体の受信状態は未確認）"
      : "IR送信に失敗しました");
    updateAirConditionerForm();
  }

  async function requestAirConditionerCommand(): Promise<void> {
    const token = config.auth?.token;
    const settings = currentAirSettings();
    if (!token || !settings || airRequestInFlight || activeAirCommandId !== null) return;
    airRequestInFlight = true;
    setText("air-conditioner-control-status", "IR送信指示を送信中…");
    updateAirConditionerForm();
    try {
      const response = await apiClient.control["air-conditioner"].$post(
        { json: settings },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) throw new Error(`IR control failed: ${response.status}`);
      const result = await response.json();
      if (typeof result.command_id !== "string") throw new Error("IR command ID is missing");
      activeAirCommandId = result.command_id;
      const earlyResult = receivedAirResults.get(result.command_id);
      if (earlyResult) {
        handleAirConditionerEvent(earlyResult);
      } else {
        setText("air-conditioner-control-status", "IR送信待ち");
        clearTimeout(airCommandTimeout);
        airCommandTimeout = setTimeout(() => {
          if (activeAirCommandId !== result.command_id) return;
          activeAirCommandId = null;
          setText("air-conditioner-control-status", "IRコントローラーから結果を確認できません");
          updateAirConditionerForm();
        }, 90000);
      }
    } catch (error) {
      activeAirCommandId = null;
      setText("air-conditioner-control-status", "IR指示の送信に失敗しました");
      console.warn("Air-conditioner control error", error);
    } finally {
      airRequestInFlight = false;
      updateAirConditionerForm();
    }
  }

  airPower?.addEventListener("change", updateAirConditionerForm);
  airMode?.addEventListener("change", updateAirConditionerForm);
  airTemp?.addEventListener("input", updateAirConditionerForm);
  airFan?.addEventListener("change", updateAirConditionerForm);
  airSwingV?.addEventListener("change", updateAirConditionerForm);
  airForm?.addEventListener("submit", (event) => event.preventDefault());
  airSendButton?.addEventListener("click", () => void requestAirConditionerCommand());
  updateAirConditionerForm();
  const identityClient = new CognitoIdentityClient({ region: config.region });
  let identityId: string | undefined;
  let client: MqttClient | undefined;
  let stopped = false;

  async function connect(): Promise<void> {
    if (stopped) return;
    try {
      let credentials: { AccessKeyId: string; SecretKey: string; SessionToken: string } | undefined;
      const accessToken = config.auth?.token;
      if (accessToken) {
        const response = await fetch("/session", { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
        if (!response.ok) throw new Error(`Authenticated IoT session failed: ${response.status}`);
        const session = await response.json() as {
          identityId?: string;
          accessKeyId?: string;
          secretAccessKey?: string;
          sessionToken?: string;
        };
        identityId = session.identityId;
        if (!session.accessKeyId || !session.secretAccessKey || !session.sessionToken) {
          throw new Error("Authenticated IoT credentials are missing");
        }
        credentials = {
          AccessKeyId: session.accessKeyId,
          SecretKey: session.secretAccessKey,
          SessionToken: session.sessionToken,
        };
      } else {
        if (!identityId) {
          identityId = (await identityClient.send(new GetIdCommand({ IdentityPoolId: config.identityPoolId }))).IdentityId;
        }
        if (!identityId) throw new Error("Cognito identity ID is missing");
        const response = await identityClient.send(new GetCredentialsForIdentityCommand({ IdentityId: identityId }));
        const guestCredentials = response.Credentials;
        if (!guestCredentials?.AccessKeyId || !guestCredentials.SecretKey || !guestCredentials.SessionToken) {
          throw new Error("Cognito guest credentials are missing");
        }
        credentials = {
          AccessKeyId: guestCredentials.AccessKeyId,
          SecretKey: guestCredentials.SecretKey,
          SessionToken: guestCredentials.SessionToken,
        };
      }
      if (!identityId || !credentials) throw new Error("IoT identity credentials are missing");
      const url = await signedUrl({
        ...config,
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretKey,
        sessionToken: credentials.SessionToken,
      });
      const mqttClient = mqtt.connect(url, {
        clientId: `reptile-cage-monitor-web-${identityId.replace(/[^A-Za-z0-9]/g, "")}-${crypto.randomUUID().slice(0, 8)}`,
        protocolVersion: 4,
        reconnectPeriod: 0,
        connectTimeout: 10000,
      });
      client = mqttClient;
      mqttClient.on("connect", () => {
        const topics = [
          "reptile-cage-monitor/cage/telemetry",
          "reptile-cage-monitor/cage/state",
        ];
        if (config.auth?.token) topics.push("reptile-cage-monitor/air-conditioner/state");
        mqttClient.subscribe(topics, { qos: 1 });
      });
      mqttClient.on("message", (topic, bytes) => {
        try {
          const payload: unknown = JSON.parse(bytes.toString());
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new Error("IoT payload must be an object");
          }
          const data = payload as Record<string, unknown>;
          if (topic.endsWith("/telemetry")) {
            if (typeof data.observed_at !== "string") return;
            const telemetry: TelemetryPayload = {
              observed_at: data.observed_at,
              temp_c: Number(data.temp_c),
              humidity: Number(data.humidity),
            };
            const age = Date.now() - Date.parse(telemetry.observed_at);
            if (!Number.isFinite(age) || age < 0 || age > 120000) return;
            window.dispatchEvent(new CustomEvent<TelemetryPayload>("reptile-cage-monitor:telemetry", { detail: telemetry }));
          } else if (topic === "reptile-cage-monitor/air-conditioner/state") {
            const event = validAirEvent(data);
            if (event) handleAirConditionerEvent(event);
          } else if (topic.endsWith("/state")) {
            if (typeof data.is_light_on === "boolean") {
              setText("light", data.is_light_on ? "ON" : "OFF");
            }
            if (typeof data.is_heater_on === "boolean") setText("heater", data.is_heater_on ? "ON" : "OFF");
          }
        } catch (error) {
          console.warn("Invalid IoT payload", error);
        }
      });
      mqttClient.on("close", () => {
        if (!stopped) setTimeout(() => void connect(), 5000);
      });
      mqttClient.on("error", (error) => console.warn("MQTT error", error));
    } catch (error) {
      console.warn("IoT connection error", error);
      if (!stopped) setTimeout(() => void connect(), 5000);
    }
  }

  window.addEventListener("beforeunload", () => {
    stopped = true;
    client?.end(true);
  });
  await connect();
}
