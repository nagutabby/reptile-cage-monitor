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
  const shadowBase = "$aws/things/reptile-controller/shadow";
  const warning = document.getElementById("sync-warning");
  const updated = document.getElementById("updated");
  const lightToggle = document.getElementById("light-toggle");
  const lightControlStatus = document.getElementById("light-control-status");
  let lightOn = null;
  let pendingLight = null;
  let pendingTimeout;
  let requestInFlight = false;
  function renderLightToggle() {
    if (!lightToggle) return;
    lightToggle.disabled = lightOn === null || pendingLight !== null || !config.lightControl?.token || !config.lightControl?.url;
    lightToggle.setAttribute("aria-checked", String(lightOn === true));
    lightToggle.setAttribute("aria-label", lightOn === null ? "ライトの状態を取得中" : `ライトを${lightOn ? "OFF" : "ON"}にする`);
  }
  lightToggle?.addEventListener("click", async () => {
    if (lightOn === null || pendingLight !== null || !config.lightControl?.token || !config.lightControl?.url) return;
    const requestedLight = !lightOn;
    pendingLight = requestedLight;
    requestInFlight = true;
    lightControlStatus.textContent = "切替中…";
    renderLightToggle();
    try {
      const response = await fetch(config.lightControl.url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.lightControl.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ is_light_on: requestedLight }),
      });
      if (!response.ok) throw new Error(`Light control failed: ${response.status}`);
      requestInFlight = false;
      if (lightOn === requestedLight) {
        pendingLight = null;
        lightControlStatus.textContent = "";
      } else {
        pendingTimeout = setTimeout(() => {
          pendingLight = null;
          lightControlStatus.textContent = "状態を確認できません";
          renderLightToggle();
        }, 90000);
      }
    } catch (error) {
      requestInFlight = false;
      pendingLight = null;
      lightControlStatus.textContent = "切替に失敗しました";
      console.warn("Light control error", error);
    }
    renderLightToggle();
  });
  renderLightToggle();
  let shadowVersion = -1;
  let shadowSnapshot;
  let lastTelemetryAt = 0;
  function showWarning(message) {
    warning.hidden = !message;
    warning.textContent = message || "";
    updated.hidden = Boolean(message);
  }
  function checkShadow() {
    if (!shadowSnapshot) return;
    const { state = {}, metadata = {} } = shadowSnapshot;
    const desired = state.desired || {};
    const reported = state.reported || {};
    const problems = [];
    for (const [key, label] of [["is_light_on", "ライト"], ["is_heater_on", "パネルヒーター"]]) {
      if (typeof desired[key] !== "boolean") {
        problems.push(`${label}のdesiredが未設定`);
      } else if (typeof reported[key] !== "boolean" || desired[key] !== reported[key]) {
        problems.push(`${label}がdesiredと同期していません`);
      }
    }
    const reportedTimes = ["is_light_on", "is_heater_on"].map((key) => metadata.reported?.[key]?.timestamp);
    if (reportedTimes.some((value) => !Number.isFinite(value)) ||
        Date.now() / 1000 - Math.min(...reportedTimes) > 180) {
      problems.push("コントローラーからの状態報告が3分以上ありません");
    }
    if (lastTelemetryAt && Date.now() - lastTelemetryAt > 180000) {
      problems.push("温度測定が3分以上ありません（ヒーターはON指示）");
    }
    showWarning(problems.length ? `状態同期の警告: ${problems.join(" / ")}` : "");
  }
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
        lastTelemetryAt = Date.now();
        client.subscribe(["reptile/cage/telemetry", "reptile/cage/state"], { qos: 1 });
        client.subscribe([`${shadowBase}/get/accepted`, `${shadowBase}/get/rejected`, `${shadowBase}/update/documents`], { qos: 1 }, (error) => {
          if (error) { showWarning("状態同期の警告: Shadowの購読に失敗しました"); return; }
          client.publish(`${shadowBase}/get`, "");
        });
      });
      client.on("message", (topic, bytes) => {
        try {
          const data = JSON.parse(bytes.toString());
          if (topic === `${shadowBase}/get/rejected`) {
            showWarning("状態同期の警告: Shadowの状態を取得できません");
          } else if (topic === `${shadowBase}/get/accepted` || topic === `${shadowBase}/update/documents`) {
            const snapshot = data.current || data;
            if (Number.isInteger(snapshot.version) && snapshot.version >= shadowVersion) {
              shadowVersion = snapshot.version;
              shadowSnapshot = snapshot;
              checkShadow();
            }
          } else if (topic.endsWith("/telemetry")) {
            const age = Date.now() - Date.parse(data.observed_at);
            if (Number.isFinite(age) && age >= 0) lastTelemetryAt = Date.parse(data.observed_at);
            checkShadow();
            if (!Number.isFinite(age) || age < 0 || age > 120000) return;
            setText("temperature", `${Number(data.temp_c).toFixed(1)} ℃`);
            setText("humidity", `${Number(data.humidity).toFixed(0)} %`);
            setText("updated", `AWS IoT Coreと最後に同期した時刻: ${new Date(data.observed_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`);
          } else if (topic.endsWith("/state")) {
            if (typeof data.is_light_on === "boolean") {
              lightOn = data.is_light_on;
              setText("light", lightOn ? "ON" : "OFF");
              if (pendingLight === lightOn && !requestInFlight) {
                clearTimeout(pendingTimeout);
                pendingLight = null;
                lightControlStatus.textContent = "";
              }
              renderLightToggle();
            }
            if (typeof data.is_heater_on === "boolean") setText("heater", data.is_heater_on ? "ON" : "OFF");
          }
        } catch (error) {
          console.warn("Invalid IoT payload", error);
        }
      });
      client.on("close", () => {
        showWarning("状態同期の警告: AWS IoT Coreへの接続が切れています");
        if (!stopped) setTimeout(connect, 5000);
      });
      client.on("error", (error) => console.warn("MQTT error", error));
    } catch (error) {
      showWarning("状態同期の警告: AWS IoT Coreに接続できません");
      console.warn("IoT connection error", error);
      if (!stopped) setTimeout(connect, 5000);
    }
  }

  window.addEventListener("beforeunload", () => { stopped = true; client?.end(true); });
  setInterval(checkShadow, 30000);
  await connect();
}
