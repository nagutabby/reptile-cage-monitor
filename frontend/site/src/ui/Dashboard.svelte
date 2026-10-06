<script lang="ts">
  import type { InferResponseType } from "hono/client";
  import { onMount } from "svelte";
  import { apiClient } from "../api-client";
  import type { LiveClientConfig } from "../live/live-client";
  import HistoryChart, { type Point } from "./HistoryChart.svelte";

  declare global {
    interface Window {
      ReptileLive?: {
        start: (config: LiveClientConfig) => Promise<void>;
      };
    }
  }

  type PublicConfig = InferResponseType<typeof apiClient.api.config.$get, 200>;
  type Reading = InferResponseType<typeof apiClient.api.readings.$get, 200>[number] & Point;
  type DeviceState = InferResponseType<typeof apiClient.api.device_state.$get, 200>;

  const ranges = [
    { label: "30分", minutes: 30 },
    { label: "6時間", minutes: 360 },
    { label: "12時間", minutes: 720 },
    { label: "1日", minutes: 1440 },
    { label: "1週間", minutes: 10080 },
  ];
  const tempMin = 24;
  const tempMax = 32;
  const humidityMin = 40;
  const humidityMax = 90;
  let config = $state<PublicConfig | null>(null);
  let idToken = $state<string | null>(null);
  let email = $state<string | null>(null);
  let readings = $state<Reading[]>([]);
  let device = $state<DeviceState>({
    is_light_on: null,
    is_light_on_changed_at: null,
    is_heater_on: null,
    is_heater_on_changed_at: null,
  });
  let rangeMinutes = $state(360);
  let latestTelemetry = $state<{ temp_c: number; humidity: number; observed_at: string } | null>(null);
  let telemetryIsLive = $state(false);
  let message = $state("接続中…");
  let loadingHistory = $state(false);

  function formatObservedAt(value: string): string {
    return new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  }

  function tokenPayload(token: string): Record<string, unknown> | null {
    try {
      const encoded = token.split(".")[1];
      return JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  function useSavedLogin() {
    const saved = sessionStorage.getItem("reptile-cage-monitor.idToken");
    if (!saved) return;
    const payload = tokenPayload(saved);
    if (!payload || Number(payload.exp) <= Date.now() / 1000) {
      sessionStorage.removeItem("reptile-cage-monitor.idToken");
      sessionStorage.removeItem("reptile-cage-monitor.email");
      return;
    }
    idToken = saved;
    email = typeof payload.email === "string" ? payload.email : sessionStorage.getItem("reptile-cage-monitor.email");
  }

  async function finishLogin() {
    if (!config || window.location.pathname !== "/oauth2callback") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    const savedState = sessionStorage.getItem("reptile-cage-monitor.oauthState");
    const verifier = sessionStorage.getItem("reptile-cage-monitor.pkceVerifier");
    if (!code || !returnedState || !savedState || returnedState !== savedState || !verifier) {
      message = params.get("error_description") ?? "ログインの確認に失敗しました。もう一度ログインしてください。";
      return;
    }
    message = "ログインを確認しています…";
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: `${window.location.origin}/oauth2callback`,
      code_verifier: verifier,
    });
    const response = await fetch(`https://${config.cognitoDomain}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error(`トークン交換に失敗しました (${response.status})`);
    const tokens = await response.json() as { id_token?: string };
    if (!tokens.id_token) throw new Error("CognitoからIDトークンが返りませんでした");
    const payload = tokenPayload(tokens.id_token);
    if (!payload || Number(payload.exp) <= Date.now() / 1000) throw new Error("IDトークンの有効期限を確認できません");
    idToken = tokens.id_token;
    email = typeof payload.email === "string" ? payload.email : null;
    sessionStorage.setItem("reptile-cage-monitor.idToken", idToken);
    if (email) sessionStorage.setItem("reptile-cage-monitor.email", email);
    sessionStorage.removeItem("reptile-cage-monitor.oauthState");
    sessionStorage.removeItem("reptile-cage-monitor.pkceVerifier");
    window.history.replaceState({}, "", "/");
  }

  async function login() {
    if (!config) return;
    const random = (size: number) => {
      const bytes = crypto.getRandomValues(new Uint8Array(size));
      return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const verifier = random(48);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const state = random(24);
    sessionStorage.setItem("reptile-cage-monitor.pkceVerifier", verifier);
    sessionStorage.setItem("reptile-cage-monitor.oauthState", state);
    const query = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: `${window.location.origin}/oauth2callback`,
      scope: "openid email profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    window.location.assign(`https://${config.cognitoDomain}/oauth2/authorize?${query}`);
  }

  function logout() {
    if (!config) return;
    sessionStorage.removeItem("reptile-cage-monitor.idToken");
    sessionStorage.removeItem("reptile-cage-monitor.email");
    const query = new URLSearchParams({ client_id: config.clientId, logout_uri: `${window.location.origin}/` });
    window.location.assign(`https://${config.cognitoDomain}/logout?${query}`);
  }

  async function getJson<T>(request: Promise<{ ok: boolean; status: number; json(): Promise<T> }>): Promise<T> {
    const response = await request;
    if (!response.ok) throw new Error(`API ${response.status}`);
    return response.json();
  }

  async function loadHistory() {
    loadingHistory = true;
    try {
      readings = await getJson(apiClient.api.readings.$get(
        { query: { minutes: String(rangeMinutes) } },
        { init: { cache: "no-store" } },
      ));
      if (!telemetryIsLive && readings.length) {
        const latest = readings.at(-1)!;
        latestTelemetry = {
          temp_c: latest.temp_c,
          humidity: latest.humidity,
          observed_at: latest.recorded_at,
        };
      }
      message = telemetryIsLive
        ? ""
        : latestTelemetry
          ? "ライブ更新を待っています。保存済みの最新値を表示中です。"
          : "ライブ値と保存済み履歴を待っています…";
    } catch (error) {
      message = error instanceof Error ? `履歴を読み込めません: ${error.message}` : "履歴を読み込めません";
    } finally {
      loadingHistory = false;
    }
  }

  async function loadState() {
    try {
      device = await getJson(apiClient.api.device_state.$get({}, { init: { cache: "no-store" } }));
    } catch (error) {
      console.warn("Could not load device state", error);
    }
  }

  async function startLive() {
    if (!config || !window.ReptileLive) return;
    const liveConfig = {
      region: config.region,
      endpoint: config.endpoint,
      identityPoolId: config.identityPoolId,
      ...(idToken ? { auth: { token: idToken } } : {}),
    };
    try {
      await window.ReptileLive.start(liveConfig);
    } catch (error) {
      console.warn("IoT live startup failed", error);
    }
  }

  onMount(() => {
    let stopped = false;
    let stateTimer: ReturnType<typeof setInterval>;
    let historyTimer: ReturnType<typeof setInterval>;
    const onTelemetry = (event: Event) => {
      latestTelemetry = (event as CustomEvent<{ temp_c: number; humidity: number; observed_at: string }>).detail;
      telemetryIsLive = true;
      message = "";
    };
    window.addEventListener("reptile-cage-monitor:telemetry", onTelemetry);
    void (async () => {
      try {
        config = await getJson(apiClient.api.config.$get({}, { init: { cache: "no-store" } }));
        if (stopped) return;
        useSavedLogin();
        await finishLogin();
        if (stopped) return;
        await Promise.all([loadHistory(), loadState()]);
        await startLive();
        historyTimer = setInterval(() => void loadHistory(), 60_000);
        stateTimer = setInterval(() => void loadState(), 60_000);
        if (!latestTelemetry) message = message || "AWS IoT Coreからのライブ値を待っています…";
      } catch (error) {
        message = error instanceof Error ? error.message : "設定を読み込めません";
      }
    })();
    return () => {
      stopped = true;
      window.removeEventListener("reptile-cage-monitor:telemetry", onTelemetry);
      clearInterval(historyTimer);
      clearInterval(stateTimer);
    };
  });

</script>

<svelte:head>
  <script is:inline src="/live-client.bundle.js"></script>
</svelte:head>

<main class="mx-auto max-w-6xl px-4 py-6 sm:px-7 sm:py-9">
  <header class="navbar mb-8 flex-col items-start gap-3 p-0 sm:flex-row sm:items-center sm:justify-between">
    <div>
      <p class="text-xs font-bold tracking-widest text-secondary">REPTILE HABITAT</p>
      <h1 class="text-2xl font-bold sm:text-3xl">レオパ温湿度モニター</h1>
    </div>
    <div class="flex w-full items-center justify-between gap-3 sm:w-auto">
      {#if idToken}
        <span class="text-sm text-base-content/70">{email ?? "ログイン中"}</span>
        <button class="btn btn-outline" onclick={logout}>ログアウト</button>
      {:else}
        <button class="btn btn-primary" onclick={login} disabled={!config}>ログイン</button>
      {/if}
    </div>
  </header>

  <section aria-label="ライブ状態">
    <div class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div><p class="text-xs font-bold tracking-widest text-secondary">LIVE NOW</p><h2 class="text-xl font-semibold">ケージの状態</h2></div>
      <p class="text-sm text-base-content/70 sm:text-right" id="updated">
        {#if latestTelemetry}
          {telemetryIsLive ? "AWS IoT Coreから受信:" : "保存済みの最終測定:"} {formatObservedAt(latestTelemetry.observed_at)}
        {:else}
          AWS IoT Coreと最後に同期した時刻: --
        {/if}
      </p>
    </div>
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <article class="stat rounded-box border border-base-300 bg-base-200"><div class="stat-title">最新温度</div><div class="stat-value text-warning" id="temperature">{latestTelemetry ? `${latestTelemetry.temp_c.toFixed(1)} ℃` : "-- ℃"}</div></article>
      <article class="stat rounded-box border border-base-300 bg-base-200"><div class="stat-title">最新湿度</div><div class="stat-value text-info" id="humidity">{latestTelemetry ? `${latestTelemetry.humidity.toFixed(0)} %` : "-- %"}</div></article>
      <article class="stat rounded-box border border-base-300 bg-base-200"><div class="stat-title">ライト</div><div class="stat-value" id="light">不明</div></article>
      <article class="stat rounded-box border border-base-300 bg-base-200"><div class="stat-title">パネルヒーター</div><div class="stat-value" id="heater">不明</div></article>
    </div>
    <article class="card card-border mt-3 border-base-300 bg-base-200">
      <div class="card-body">
        <form id="air-conditioner-form">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h3 class="card-title text-base">エアコン</h3>
            <div class="flex items-center gap-3">
              <small id="ac-availability" class="text-base-content/70" aria-live="polite">{idToken === null ? "ログインするとエアコンを操作できます" : ""}</small>
              <button type="button" id="air-conditioner-send" class="btn btn-primary" disabled={idToken === null}>データを送信</button>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <label class="form-control flex flex-col gap-1 text-sm">電源
              <select id="ac-power" class="select w-full"><option value="on" selected>ON</option><option value="off">OFF</option></select>
            </label>
            <label class="form-control flex flex-col gap-1 text-sm">冷房 or 暖房
              <select id="ac-mode" class="select w-full"><option value="cool" selected>冷房</option><option value="heat">暖房</option></select>
            </label>
            <label class="form-control flex flex-col gap-1 text-sm">設定温度（0.5℃刻み）
              <input id="ac-temp" class="input w-full" type="number" min="18" max="32" step="0.5" value="27" required />
            </label>
            <label class="form-control flex flex-col gap-1 text-sm">上下の風向
              <select id="ac-swing-v" class="select w-full">
                <option value="off">固定（現在位置）</option><option value="swing">スイング</option><option value="highest">一番上</option><option value="high">上</option><option value="upper_middle">上中</option><option value="lower_middle">下中</option><option value="low">下</option><option value="lowest">一番下</option><option value="breeze">そよ風</option><option value="circulate">循環</option>
              </select>
            </label>
            <label class="form-control flex flex-col gap-1 text-sm">風量
              <select id="ac-fan" class="select w-full"><option value="auto" selected>自動</option><option value="quiet">静音</option><option value="1">1（弱）</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5（強）</option></select>
            </label>
          </div>
        </form>
        <small id="air-conditioner-control-status" class="control-status min-h-4 text-warning" role="status" aria-live="polite"></small>
      </div>
    </article>
    {#if message}<p class="mt-4 text-sm text-warning" role="status">{message}</p>{/if}
  </section>

  <section class="mt-10" aria-label="温湿度の履歴">
    <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div><p class="text-xs font-bold tracking-widest text-secondary">HISTORY</p><h2 class="text-xl font-semibold">温湿度の推移</h2></div>
      <div class="join w-full sm:w-auto" role="group" aria-label="グラフの表示範囲">
        {#each ranges as range}
          <button class="btn btn-sm join-item flex-1 sm:flex-none" class:btn-primary={rangeMinutes === range.minutes} aria-pressed={rangeMinutes === range.minutes} onclick={() => { rangeMinutes = range.minutes; void loadHistory(); }}>{range.label}</button>
        {/each}
      </div>
    </div>
    <div class="card card-border mt-3 border-base-300 bg-base-200">
      <div class="card-body p-4">
        <div class="flex items-center justify-between"><h3 class="font-semibold">温度</h3><span class="badge badge-warning badge-outline">温度（℃）</span></div>
        <HistoryChart data={readings} valueKey="temp_c" min={tempMin} max={tempMax} color="#ffb86c" title="温度" />
      </div>
    </div>
    <div class="card card-border mt-3 border-base-300 bg-base-200">
      <div class="card-body p-4">
        <div class="flex items-center justify-between"><h3 class="font-semibold">湿度</h3><span class="badge badge-info badge-outline">湿度（%）</span></div>
        <HistoryChart data={readings} valueKey="humidity" min={humidityMin} max={humidityMax} color="#8be9fd" title="湿度" />
      </div>
    </div>
    {#if loadingHistory}<footer class="mt-3 text-right text-sm text-base-content/70">履歴を更新しています…</footer>{/if}
  </section>
</main>
