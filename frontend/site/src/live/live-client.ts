import mqtt, { type MqttClient } from "mqtt";
import { CognitoIdentityClient, GetCredentialsForIdentityCommand, GetIdCommand } from "@aws-sdk/client-cognito-identity";
import type { AirConditionerSettings } from "../../../../lambda/api";
import { apiClient } from "../api-client";

export interface LiveClientConfig {
  region: string;
  endpoint: string;
  identityPoolId: string;
  lightControl?: {
    token: string;
  };
}

const AIR_CONDITIONER_STATE_TOPIC = "reptile-cage-monitor/air-conditioner/state";

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
  const setControlStatus = (value: string): void => {
    const element = document.getElementById("light-control-status");
    if (element) element.textContent = value;
  };
  const setAirConditionerStatus = (value: string): void => {
    const element = document.getElementById("air-conditioner-control-status");
    if (element) element.textContent = value;
  };
  const airConditionerForm = document.querySelector<HTMLFormElement>("#air-conditioner-form");
  const airConditionerSendButton = document.querySelector<HTMLButtonElement>("#air-conditioner-send");
  const airConditionerMode = document.querySelector<HTMLSelectElement>("#ac-mode");
  const airConditionerTemp = document.querySelector<HTMLInputElement>("#ac-temp");
  const airConditionerHumidity = document.querySelector<HTMLSelectElement>("#ac-humidity");
  const airConditionerHumidityField = document.querySelector<HTMLElement>("#ac-humidity-field");
  let airRequestInFlight = false;
  let activeAirCommandId: string | null = null;
  let airCommandTimeout: ReturnType<typeof setTimeout> | undefined;
  const receivedAirResults = new Map<string, "sent" | "failed">();

  function renderAirConditionerForm(): void {
    if (airConditionerSendButton) {
      airConditionerSendButton.disabled = !config.lightControl?.token || airRequestInFlight;
    }
  }

  function renderAirConditionerResult(commandId: string, status: "sent" | "failed"): void {
    receivedAirResults.set(commandId, status);
    if (receivedAirResults.size > 8) {
      const oldest = receivedAirResults.keys().next().value;
      if (oldest) receivedAirResults.delete(oldest);
    }
    if (activeAirCommandId !== null && activeAirCommandId !== commandId) return;
    clearTimeout(airCommandTimeout);
    const prefix = activeAirCommandId === null ? "前回の結果: " : "";
    setAirConditionerStatus(status === "sent"
      ? `${prefix}IR送信済み（本体の受信状態は未確認）`
      : `${prefix}IR送信失敗`);
    if (activeAirCommandId === commandId) activeAirCommandId = null;
  }

  const updateAirConditionerFields = (): void => {
    const mode = airConditionerMode?.value;
    if (airConditionerTemp) {
      airConditionerTemp.min = mode === "cool" ? "18" : "10";
      if (mode === "cool" && Number(airConditionerTemp.value) < 18) airConditionerTemp.value = "18";
    }
    if (airConditionerHumidityField && airConditionerHumidity) {
      const humiditySupported = mode === "heat" || mode === "dry";
      airConditionerHumidityField.hidden = !humiditySupported;
      const value = airConditionerHumidity.value;
      if ((mode === "heat" && (value === "55" || value === "60"))
        || (mode === "dry" && (value === "40" || value === "45"))) {
        airConditionerHumidity.value = "off";
      }
      if (!humiditySupported) airConditionerHumidity.value = "off";
    }
  };
  airConditionerMode?.addEventListener("change", updateAirConditionerFields);
  updateAirConditionerFields();

  const quietCheckbox = document.querySelector<HTMLInputElement>("#ac-quiet");
  const powerfulCheckbox = document.querySelector<HTMLInputElement>("#ac-powerful");
  quietCheckbox?.addEventListener("change", () => {
    if (quietCheckbox.checked && powerfulCheckbox) powerfulCheckbox.checked = false;
  });
  powerfulCheckbox?.addEventListener("change", () => {
    if (powerfulCheckbox.checked && quietCheckbox) quietCheckbox.checked = false;
  });

  airConditionerForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = config.lightControl?.token;
    if (!token || airRequestInFlight) return;
    const settings: AirConditionerSettings = {
      power: document.querySelector<HTMLSelectElement>("#ac-power")?.value === "on",
      mode: (airConditionerMode?.value ?? "cool") as AirConditionerSettings["mode"],
      temp_c: Number(airConditionerTemp?.value ?? 27),
      fan: (document.querySelector<HTMLSelectElement>("#ac-fan")?.value ?? "auto") as AirConditionerSettings["fan"],
      swing_v: (document.querySelector<HTMLSelectElement>("#ac-swing-v")?.value ?? "highest") as AirConditionerSettings["swing_v"],
      swing_h: (document.querySelector<HTMLSelectElement>("#ac-swing-h")?.value ?? "off") as AirConditionerSettings["swing_h"],
      quiet: quietCheckbox?.checked ?? false,
      powerful: powerfulCheckbox?.checked ?? false,
      econo: document.querySelector<HTMLInputElement>("#ac-econo")?.checked ?? false,
      eye: document.querySelector<HTMLInputElement>("#ac-eye")?.checked ?? false,
      eye_auto: document.querySelector<HTMLInputElement>("#ac-eye-auto")?.checked ?? false,
      eye_timer: (document.querySelector<HTMLSelectElement>("#ac-eye-timer")?.value ?? "off") as AirConditionerSettings["eye_timer"],
      purify: document.querySelector<HTMLInputElement>("#ac-purify")?.checked ?? false,
      mold: document.querySelector<HTMLInputElement>("#ac-mold")?.checked ?? false,
      clean: document.querySelector<HTMLInputElement>("#ac-clean")?.checked ?? false,
      fresh_air: (document.querySelector<HTMLSelectElement>("#ac-fresh-air")?.value ?? "off") as AirConditionerSettings["fresh_air"],
      humidity: (airConditionerHumidity?.value ?? "off") as AirConditionerSettings["humidity"],
      beep: (document.querySelector<HTMLSelectElement>("#ac-beep")?.value ?? "quiet") as AirConditionerSettings["beep"],
      light: (document.querySelector<HTMLSelectElement>("#ac-light")?.value ?? "bright") as AirConditionerSettings["light"],
    };
    airRequestInFlight = true;
    setAirConditionerStatus("設定を送信中…");
    renderAirConditionerForm();
    try {
      const response = await apiClient.control["air-conditioner"].$post(
        { json: settings },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) throw new Error(`Air-conditioner control failed: ${response.status}`);
      const result = await response.json();
      if (typeof result.command_id !== "string") throw new Error("Air-conditioner command ID is missing");
      activeAirCommandId = result.command_id;
      const earlyResult = receivedAirResults.get(result.command_id);
      if (earlyResult) {
        renderAirConditionerResult(result.command_id, earlyResult);
      } else {
        setAirConditionerStatus("送信待ち");
        clearTimeout(airCommandTimeout);
        airCommandTimeout = setTimeout(() => {
          if (activeAirCommandId !== result.command_id) return;
          activeAirCommandId = null;
          setAirConditionerStatus("送信結果を確認できません");
        }, 90000);
      }
    } catch (error) {
      activeAirCommandId = null;
      setAirConditionerStatus("設定送信に失敗しました");
      console.warn("Air-conditioner control error", error);
    } finally {
      airRequestInFlight = false;
      renderAirConditionerForm();
    }
  });
  renderAirConditionerForm();

  const lightToggle = document.querySelector<HTMLButtonElement>("#light-toggle");
  let lightOn: boolean | null = null;
  let pendingLight: boolean | null = null;
  let pendingTimeout: ReturnType<typeof setTimeout> | undefined;
  let requestInFlight = false;

  function renderLightToggle(): void {
    if (!lightToggle) return;
    const displayLightOn = pendingLight ?? lightOn;
    lightToggle.disabled = lightOn === null || pendingLight !== null || !config.lightControl?.token;
    lightToggle.setAttribute("aria-checked", String(displayLightOn === true));
    lightToggle.setAttribute("aria-label", displayLightOn === null ? "ライトの状態を取得中" : `ライトを${displayLightOn ? "OFF" : "ON"}にする`);
  }

  lightToggle?.addEventListener("click", async () => {
    if (lightOn === null || pendingLight !== null || !config.lightControl?.token) return;
    const requestedLight = !lightOn;
    pendingLight = requestedLight;
    requestInFlight = true;
    setControlStatus("切替中…");
    renderLightToggle();
    try {
      const response = await apiClient.control.light.$post(
        { json: { is_light_on: requestedLight } },
        { headers: { Authorization: `Bearer ${config.lightControl.token}` } },
      );
      if (!response.ok) throw new Error(`Light control failed: ${response.status}`);
      requestInFlight = false;
      if (lightOn === requestedLight) {
        pendingLight = null;
        setControlStatus("");
      } else {
        pendingTimeout = setTimeout(() => {
          pendingLight = null;
          setControlStatus("状態を確認できません");
          renderLightToggle();
        }, 90000);
      }
    } catch (error) {
      requestInFlight = false;
      pendingLight = null;
      setControlStatus("切替に失敗しました");
      console.warn("Light control error", error);
    }
    renderLightToggle();
  });

  renderLightToggle();
  const identityClient = new CognitoIdentityClient({ region: config.region });
  let identityId: string | undefined;
  let client: MqttClient | undefined;
  let stopped = false;

  async function connect(): Promise<void> {
    if (stopped) return;
    try {
      if (!identityId) {
        identityId = (await identityClient.send(new GetIdCommand({ IdentityPoolId: config.identityPoolId }))).IdentityId;
      }
      if (!identityId) throw new Error("Cognito identity ID is missing");
      const response = await identityClient.send(new GetCredentialsForIdentityCommand({ IdentityId: identityId }));
      const credentials = response.Credentials;
      if (!credentials?.AccessKeyId || !credentials.SecretKey || !credentials.SessionToken) {
        throw new Error("Cognito guest credentials are missing");
      }
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
        mqttClient.subscribe([
          "reptile-cage-monitor/cage/telemetry",
          "reptile-cage-monitor/cage/state",
          AIR_CONDITIONER_STATE_TOPIC,
        ], { qos: 1 });
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
          } else if (topic === AIR_CONDITIONER_STATE_TOPIC) {
            if (typeof data.command_id === "string" && (data.status === "sent" || data.status === "failed")) {
              renderAirConditionerResult(data.command_id, data.status);
            }
          } else if (topic.endsWith("/state")) {
            if (typeof data.is_light_on === "boolean") {
              lightOn = data.is_light_on;
              setText("light", lightOn ? "ON" : "OFF");
              if (pendingLight === lightOn && !requestInFlight) {
                clearTimeout(pendingTimeout);
                pendingLight = null;
                setControlStatus("");
              }
              renderLightToggle();
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
