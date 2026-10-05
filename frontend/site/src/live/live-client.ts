import mqtt, { type MqttClient } from "mqtt";
import { CognitoIdentityClient, GetCredentialsForIdentityCommand, GetIdCommand } from "@aws-sdk/client-cognito-identity";
import { apiClient } from "../api-client";
import type { AirConditionerPreset } from "../../../../lambda/api";

export interface LiveClientConfig {
  region: string;
  endpoint: string;
  identityPoolId: string;
  lightControl?: {
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
  status: "learning" | "captured" | "sent" | "failed";
  preset: AirConditionerPreset;
  raw_data?: number[];
}

interface SavedAirConditionerPreset {
  name: string;
  raw_data?: number[];
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
  const AIR_PRESET_STORAGE_KEY = "reptile-cage-monitor.air-conditioner-presets.v1";
  const airMode = document.querySelector<HTMLSelectElement>("#ac-mode");
  const airTemp = document.querySelector<HTMLInputElement>("#ac-temp");
  const airFan = document.querySelector<HTMLSelectElement>("#ac-fan");
  const airSwingV = document.querySelector<HTMLSelectElement>("#ac-swing-v");
  const airPresetName = document.querySelector<HTMLInputElement>("#ac-preset-name");
  const airLearnButton = document.querySelector<HTMLButtonElement>("#air-conditioner-learn");
  const airSendButton = document.querySelector<HTMLButtonElement>("#air-conditioner-send");
  const airAvailability = document.querySelector<HTMLElement>("#ac-preset-availability");
  const airForm = document.querySelector<HTMLFormElement>("#air-conditioner-form");
  let savedAirPresets: Record<string, SavedAirConditionerPreset> = {};
  try {
    const saved = localStorage.getItem(AIR_PRESET_STORAGE_KEY);
    const parsed: unknown = saved ? JSON.parse(saved) : {};
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      savedAirPresets = parsed as Record<string, SavedAirConditionerPreset>;
    }
  } catch (error) {
    console.warn("Could not read saved IR presets", error);
  }
  let displayedAirPresetKey: string | null = null;
  let airRequestInFlight = false;
  let activeAirCommandId: string | null = null;
  let airCommandTimeout: ReturnType<typeof setTimeout> | undefined;
  const receivedAirResults = new Map<string, AirConditionerEvent>();

  function presetKey(preset: AirConditionerPreset): string {
    return JSON.stringify([preset.mode, preset.temp_c.toFixed(1), preset.swing_v, preset.fan]);
  }

  function presetName(preset: AirConditionerPreset): string {
    const mode = preset.mode === "cool" ? "冷房" : "暖房";
    const swingLabels: Record<AirConditionerPreset["swing_v"], string> = {
      off: "固定", swing: "スイング", highest: "一番上", high: "上", upper_middle: "上中",
      lower_middle: "下中", low: "下", lowest: "一番下", breeze: "そよ風", circulate: "循環",
    };
    const fanLabels: Record<AirConditionerPreset["fan"], string> = {
      auto: "自動", quiet: "静音", "1": "1（弱）", "2": "2", "3": "3", "4": "4", "5": "5（強）",
    };
    const swing = swingLabels[preset.swing_v];
    const fan = fanLabels[preset.fan];
    return `${mode} ${preset.temp_c.toFixed(1)}℃・${swing}・${fan}`;
  }

  function currentAirPreset(): AirConditionerPreset | null {
    const mode = airMode?.value;
    const temp = Number(airTemp?.value);
    const fan = airFan?.value;
    const swingV = airSwingV?.value;
    if ((mode !== "cool" && mode !== "heat") || !Number.isFinite(temp)
      || !Number.isInteger(temp * 2) || temp < 10 || temp > 32
      || (mode === "cool" && temp < 18) || !fan || !swingV) return null;
    return {
      mode,
      temp_c: temp,
      fan: fan as AirConditionerPreset["fan"],
      swing_v: swingV as AirConditionerPreset["swing_v"],
    };
  }

  function saveAirPresets(): boolean {
    try {
      localStorage.setItem(AIR_PRESET_STORAGE_KEY, JSON.stringify(savedAirPresets));
      return true;
    } catch (error) {
      console.warn("Could not save IR presets", error);
      return false;
    }
  }

  function isRawTimingArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.length >= 2 && value.length <= 700
      && value.every((duration) => typeof duration === "number" && Number.isInteger(duration)
        && duration > 0 && duration <= 65_535);
  }

  function updateAirConditionerForm(forceName = false): void {
    if (!airMode || !airTemp || !airLearnButton || !airSendButton) return;
    airTemp.min = airMode.value === "cool" ? "18" : "10";
    if (airMode.value === "cool" && Number(airTemp.value) < 18) airTemp.value = "18";
    const preset = currentAirPreset();
    if (!preset) {
      if (airAvailability) airAvailability.textContent = "温度を入力してください";
      airLearnButton.disabled = true;
      airSendButton.disabled = true;
      return;
    }
    const key = presetKey(preset);
    const stored = savedAirPresets[key];
    if (forceName || displayedAirPresetKey !== key) {
      if (airPresetName) airPresetName.value = stored?.name ?? presetName(preset);
      displayedAirPresetKey = key;
    }
    const learned = isRawTimingArray(stored?.raw_data);
    if (airAvailability) airAvailability.textContent = learned ? "この組み合わせは学習済みです" : "この組み合わせは未学習です";
    const canControl = Boolean(config.lightControl?.token) && !airRequestInFlight;
    airLearnButton.disabled = !canControl;
    airSendButton.disabled = !canControl || !learned;
  }

  function validAirEvent(value: Record<string, unknown>): AirConditionerEvent | null {
    const preset = value.preset as Record<string, unknown> | undefined;
    if (typeof value.command_id !== "string"
      || (value.status !== "learning" && value.status !== "captured" && value.status !== "sent" && value.status !== "failed")
      || !preset || typeof preset !== "object"
      || (preset.mode !== "cool" && preset.mode !== "heat")
      || typeof preset.temp_c !== "number" || !Number.isInteger(preset.temp_c * 2)
      || typeof preset.fan !== "string" || typeof preset.swing_v !== "string") return null;
    const result: AirConditionerEvent = {
      command_id: value.command_id,
      status: value.status,
      preset: preset as unknown as AirConditionerPreset,
    };
    if (value.raw_data !== undefined) {
      if (!isRawTimingArray(value.raw_data)) return null;
      result.raw_data = value.raw_data;
    }
    if (result.status === "captured" && !result.raw_data) return null;
    return result;
  }

  function handleAirConditionerEvent(event: AirConditionerEvent): void {
    receivedAirResults.set(event.command_id, event);
    if (receivedAirResults.size > 8) {
      const oldest = receivedAirResults.keys().next().value;
      if (oldest) receivedAirResults.delete(oldest);
    }
    const key = presetKey(event.preset);
    if (event.status === "captured" && event.raw_data) {
      const typedName = key === (currentAirPreset() ? presetKey(currentAirPreset()!) : null)
        ? airPresetName?.value.trim()
        : "";
      const name = typedName || savedAirPresets[key]?.name || presetName(event.preset);
      savedAirPresets[key] = { name, raw_data: event.raw_data };
      if (!saveAirPresets()) setText("air-conditioner-control-status", "学習データをブラウザーに保存できませんでした");
      updateAirConditionerForm();
    }
    if (activeAirCommandId !== null && activeAirCommandId !== event.command_id) return;
    if (event.status === "learning") {
      setText("air-conditioner-control-status", "リモコン信号を待っています（30秒以内に操作してください）");
      return;
    }
    if (event.status === "captured") {
      clearTimeout(airCommandTimeout);
      setText("air-conditioner-control-status", "生データを学習し、この組み合わせに保存しました");
    } else if (event.status === "sent") {
      clearTimeout(airCommandTimeout);
      setText("air-conditioner-control-status", "生データを送信しました（本体の受信状態は未確認）");
    } else if (event.status === "failed") {
      clearTimeout(airCommandTimeout);
      setText("air-conditioner-control-status", "IR学習または送信に失敗しました");
    }
    if (activeAirCommandId === event.command_id) activeAirCommandId = null;
    updateAirConditionerForm();
  }

  async function requestAirConditionerCommand(operation: "learn" | "send"): Promise<void> {
    const token = config.lightControl?.token;
    const preset = currentAirPreset();
    if (!token || !preset || airRequestInFlight) return;
    const stored = savedAirPresets[presetKey(preset)];
    if (operation === "send" && !isRawTimingArray(stored?.raw_data)) return;
    airRequestInFlight = true;
    setText("air-conditioner-control-status", operation === "learn" ? "学習指示を送信中…" : "IR送信指示を送信中…");
    updateAirConditionerForm();
    try {
      const command = operation === "learn"
        ? { operation, preset }
        : { operation, preset, raw_data: stored!.raw_data! };
      const response = await apiClient.control["air-conditioner"].$post(
        { json: command },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) throw new Error(`IR control failed: ${response.status}`);
      const result = await response.json();
      if (typeof result.command_id !== "string") throw new Error("IR command ID is missing");
      activeAirCommandId = result.command_id;
      const earlyResult = receivedAirResults.get(result.command_id);
      if (earlyResult) {
        handleAirConditionerEvent(earlyResult);
        if (earlyResult.status === "learning" && activeAirCommandId === result.command_id) {
          clearTimeout(airCommandTimeout);
          airCommandTimeout = setTimeout(() => {
            if (activeAirCommandId !== result.command_id) return;
            activeAirCommandId = null;
            setText("air-conditioner-control-status", "IRコントローラーから結果を確認できません");
            updateAirConditionerForm();
          }, 45000);
        }
      } else {
        setText("air-conditioner-control-status", operation === "learn" ? "リモコン信号を待っています（30秒以内に操作してください）" : "IR送信待ち");
        clearTimeout(airCommandTimeout);
        airCommandTimeout = setTimeout(() => {
          if (activeAirCommandId !== result.command_id) return;
          activeAirCommandId = null;
          setText("air-conditioner-control-status", "IRコントローラーから結果を確認できません");
          updateAirConditionerForm();
        }, operation === "learn" ? 45000 : 90000);
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

  airMode?.addEventListener("change", () => updateAirConditionerForm(true));
  airTemp?.addEventListener("input", () => updateAirConditionerForm());
  airFan?.addEventListener("change", () => updateAirConditionerForm(true));
  airSwingV?.addEventListener("change", () => updateAirConditionerForm(true));
  airPresetName?.addEventListener("input", () => {
    const preset = currentAirPreset();
    if (!preset) return;
    const key = presetKey(preset);
    savedAirPresets[key] = {
      ...savedAirPresets[key],
      name: airPresetName.value.trim() || presetName(preset),
    };
    if (!saveAirPresets()) setText("air-conditioner-control-status", "プリセット名をブラウザーに保存できませんでした");
  });
  airForm?.addEventListener("submit", (event) => event.preventDefault());
  airLearnButton?.addEventListener("click", () => void requestAirConditionerCommand("learn"));
  airSendButton?.addEventListener("click", () => void requestAirConditionerCommand("send"));
  updateAirConditionerForm(true);

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
      let credentials: { AccessKeyId: string; SecretKey: string; SessionToken: string } | undefined;
      const accessToken = config.lightControl?.token;
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
        if (config.lightControl?.token) topics.push("reptile-cage-monitor/air-conditioner/state");
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
