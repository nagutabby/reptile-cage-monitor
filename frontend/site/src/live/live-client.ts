import mqtt, { type MqttClient } from "mqtt";
import { CognitoIdentityClient, GetCredentialsForIdentityCommand, GetIdCommand } from "@aws-sdk/client-cognito-identity";
import { apiClient } from "../api-client";
import type { AirConditionerPreset, AirConditionerPresetRecord } from "../../../../lambda/api";

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
  preset_id: number;
  status: "learning" | "captured" | "sent" | "failed";
  preset: AirConditionerPreset;
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
  const airMode = document.querySelector<HTMLSelectElement>("#ac-mode");
  const airTemp = document.querySelector<HTMLInputElement>("#ac-temp");
  const airFan = document.querySelector<HTMLSelectElement>("#ac-fan");
  const airSwingV = document.querySelector<HTMLSelectElement>("#ac-swing-v");
  const airPresetName = document.querySelector<HTMLInputElement>("#ac-preset-name");
  const airSaveButton = document.querySelector<HTMLButtonElement>("#air-conditioner-save");
  const airSendButton = document.querySelector<HTMLButtonElement>("#air-conditioner-send");
  const airAvailability = document.querySelector<HTMLElement>("#ac-preset-availability");
  const airForm = document.querySelector<HTMLFormElement>("#air-conditioner-form");
  const presetSlotButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-air-preset-id]"));
  let airPresets: AirConditionerPresetRecord[] = [];
  let selectedPresetId = 1;
  let presetsLoaded = false;
  let airRequestInFlight = false;
  let savingPreset = false;
  let activeAirCommandId: string | null = null;
  let airCommandTimeout: ReturnType<typeof setTimeout> | undefined;
  const receivedAirResults = new Map<string, AirConditionerEvent>();

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

  function selectedPreset(): AirConditionerPresetRecord | undefined {
    return airPresets.find((preset) => preset.preset_id === selectedPresetId);
  }

  function renderPresetSlots(): void {
    for (const button of presetSlotButtons) {
      const presetId = Number(button.dataset.airPresetId);
      const preset = airPresets.find((item) => item.preset_id === presetId);
      button.textContent = preset
        ? `枠 ${presetId} · ${preset.name} · ${preset.learned ? "学習済み" : "未学習"}`
        : `枠 ${presetId} · 読み込み中`;
      button.setAttribute("aria-pressed", String(presetId === selectedPresetId));
      button.disabled = !config.lightControl?.token || !presetsLoaded || savingPreset;
    }
  }

  function setPresetForm(preset: AirConditionerPresetRecord): void {
    if (!airMode || !airTemp || !airFan || !airSwingV || !airPresetName) return;
    airMode.value = preset.mode;
    airTemp.value = String(preset.temp_c);
    airFan.value = preset.fan;
    airSwingV.value = preset.swing_v;
    airPresetName.value = preset.name;
    updateAirConditionerForm();
  }

  function isPresetDirty(preset: AirConditionerPresetRecord | undefined): boolean {
    const formPreset = currentAirPreset();
    if (!preset || !formPreset || !airPresetName) return true;
    return formPreset.mode !== preset.mode || formPreset.temp_c !== preset.temp_c
      || formPreset.fan !== preset.fan || formPreset.swing_v !== preset.swing_v
      || airPresetName.value.trim() !== preset.name;
  }

  function updateAirConditionerForm(): void {
    if (!airMode || !airTemp || !airSaveButton || !airSendButton) return;
    airTemp.min = airMode.value === "cool" ? "18" : "10";
    if (airMode.value === "cool" && Number(airTemp.value) < 18) airTemp.value = "18";
    const preset = currentAirPreset();
    if (!preset) {
      if (airAvailability) airAvailability.textContent = "温度を入力してください";
      airSaveButton.disabled = true;
      airSendButton.disabled = true;
      return;
    }
    const stored = selectedPreset();
    const dirty = isPresetDirty(stored);
    const learned = Boolean(stored?.learned);
    if (airAvailability) {
      airAvailability.textContent = !config.lightControl?.token
        ? "ログインするとプリセットを編集できます"
        : dirty ? "変更した設定を保存してください"
          : learned ? `枠 ${selectedPresetId} は学習済みです` : `枠 ${selectedPresetId} は未学習です。Unit IR本体で学習してください`;
    }
    const canControl = Boolean(config.lightControl?.token) && presetsLoaded && !airRequestInFlight && !savingPreset;
    airSaveButton.disabled = !canControl || !stored || !dirty;
    airSendButton.disabled = !canControl || dirty || !learned;
    renderPresetSlots();
  }

  function validAirEvent(value: Record<string, unknown>): AirConditionerEvent | null {
    const preset = value.preset as Record<string, unknown> | undefined;
    if (typeof value.command_id !== "string"
      || !Number.isInteger(value.preset_id) || Number(value.preset_id) < 1 || Number(value.preset_id) > 4
      || (value.status !== "learning" && value.status !== "captured" && value.status !== "sent" && value.status !== "failed")
      || !preset || typeof preset !== "object"
      || (preset.mode !== "cool" && preset.mode !== "heat")
      || typeof preset.temp_c !== "number" || !Number.isInteger(preset.temp_c * 2)
      || typeof preset.fan !== "string" || typeof preset.swing_v !== "string") return null;
    const result: AirConditionerEvent = {
      command_id: value.command_id,
      preset_id: Number(value.preset_id),
      status: value.status,
      preset: preset as unknown as AirConditionerPreset,
    };
    return result;
  }

  function handleAirConditionerEvent(event: AirConditionerEvent): void {
    receivedAirResults.set(event.command_id, event);
    if (receivedAirResults.size > 8) {
      const oldest = receivedAirResults.keys().next().value;
      if (oldest) receivedAirResults.delete(oldest);
    }
    if (event.status === "captured") {
      setText("air-conditioner-control-status", `本体で枠 ${event.preset_id} の信号を学習しました`);
      setTimeout(() => void loadAirPresets(), 1500);
    }
    if (activeAirCommandId !== null && activeAirCommandId !== event.command_id) return;
    if (event.status === "learning") {
      setText("air-conditioner-control-status", `枠 ${event.preset_id} の信号を待っています（60秒以内）`);
      return;
    }
    if (event.status === "captured") {
      clearTimeout(airCommandTimeout);
      setText("air-conditioner-control-status", `枠 ${event.preset_id} の信号を保存しました`);
    } else if (event.status === "sent") {
      clearTimeout(airCommandTimeout);
      setText("air-conditioner-control-status", `枠 ${event.preset_id} のIR信号を送信しました（本体の受信状態は未確認）`);
    } else if (event.status === "failed") {
      clearTimeout(airCommandTimeout);
      setText("air-conditioner-control-status", "IR学習または送信に失敗しました");
    }
    if (activeAirCommandId === event.command_id) activeAirCommandId = null;
    updateAirConditionerForm();
  }

  async function loadAirPresets(): Promise<void> {
    const token = config.lightControl?.token;
    if (!token) {
      airAvailability && (airAvailability.textContent = "ログインするとプリセットを編集できます");
      return;
    }
    try {
      const response = await fetch("/api/air-conditioner-presets", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Preset load failed: ${response.status}`);
      const values = await response.json() as AirConditionerPresetRecord[];
      if (!Array.isArray(values) || values.length !== 4) throw new Error("API returned an invalid preset list");
      airPresets = values;
      presetsLoaded = true;
      const current = selectedPreset();
      if (current) setPresetForm(current);
      updateAirConditionerForm();
    } catch (error) {
      setText("air-conditioner-control-status", "プリセットを読み込めませんでした");
      console.warn("Could not load IR presets", error);
    }
  }

  async function saveAirConditionerPreset(): Promise<void> {
    const token = config.lightControl?.token;
    const preset = currentAirPreset();
    if (!token || !preset || !airPresetName || savingPreset) return;
    savingPreset = true;
    updateAirConditionerForm();
    setText("air-conditioner-control-status", `枠 ${selectedPresetId} の設定を保存中…`);
    try {
      const response = await fetch(`/api/air-conditioner-presets/${selectedPresetId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...preset, name: airPresetName.value.trim() || presetName(preset) }),
      });
      if (!response.ok) throw new Error(`Preset save failed: ${response.status}`);
      const savedPreset = await response.json() as AirConditionerPresetRecord;
      airPresets = airPresets.map((item) => item.preset_id === selectedPresetId ? savedPreset : item);
      setPresetForm(savedPreset);
      setText("air-conditioner-control-status", `枠 ${selectedPresetId} の設定を保存し、本体へ同期を依頼しました`);
    } catch (error) {
      setText("air-conditioner-control-status", "プリセットの保存に失敗しました");
      console.warn("Could not save IR preset", error);
    } finally {
      savingPreset = false;
      updateAirConditionerForm();
    }
  }

  async function requestAirConditionerCommand(): Promise<void> {
    const token = config.lightControl?.token;
    const preset = currentAirPreset();
    const stored = selectedPreset();
    if (!token || !preset || !stored || !stored.learned || isPresetDirty(stored) || airRequestInFlight) return;
    airRequestInFlight = true;
    setText("air-conditioner-control-status", `枠 ${selectedPresetId} のIR送信指示を送信中…`);
    updateAirConditionerForm();
    try {
      const command = {
        operation: "send" as const,
        preset_id: stored.preset_id,
        revision: stored.revision,
        preset,
      };
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

  for (const button of presetSlotButtons) {
    button.addEventListener("click", () => {
      const presetId = Number(button.dataset.airPresetId);
      const preset = airPresets.find((item) => item.preset_id === presetId);
      if (!preset) return;
      selectedPresetId = presetId;
      setPresetForm(preset);
    });
  }
  airMode?.addEventListener("change", updateAirConditionerForm);
  airTemp?.addEventListener("input", () => updateAirConditionerForm());
  airFan?.addEventListener("change", updateAirConditionerForm);
  airSwingV?.addEventListener("change", updateAirConditionerForm);
  airPresetName?.addEventListener("input", updateAirConditionerForm);
  airForm?.addEventListener("submit", (event) => event.preventDefault());
  airSaveButton?.addEventListener("click", () => void saveAirConditionerPreset());
  airSendButton?.addEventListener("click", () => void requestAirConditionerCommand());
  renderPresetSlots();
  updateAirConditionerForm();
  if (config.lightControl?.token) void loadAirPresets();

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
