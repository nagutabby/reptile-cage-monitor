<script lang="ts">
  import { onMount } from "svelte";
  import HistoryChart, { type Point } from "./HistoryChart.svelte";

  declare global {
    interface Window {
      ReptileLive?: {
        start: (config: Record<string, unknown>) => Promise<void>;
      };
    }
  }

  interface PublicConfig {
    region: string;
    endpoint: string;
    identityPoolId: string;
    userPoolId: string;
    clientId: string;
    cognitoDomain: string;
  }

  interface Reading extends Point { id: string | number; }
  interface DeviceState {
    is_light_on: boolean | null;
    is_light_on_changed_at: string | null;
    is_heater_on: boolean | null;
    is_heater_on_changed_at: string | null;
  }

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
  let message = $state("接続中…");
  let loadingHistory = $state(false);

  function activeRangeLabel() {
    return ranges.find((range) => range.minutes === rangeMinutes)?.label ?? "6時間";
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
    const saved = sessionStorage.getItem("reptile.idToken");
    if (!saved) return;
    const payload = tokenPayload(saved);
    if (!payload || Number(payload.exp) <= Date.now() / 1000) {
      sessionStorage.removeItem("reptile.idToken");
      sessionStorage.removeItem("reptile.email");
      return;
    }
    idToken = saved;
    email = typeof payload.email === "string" ? payload.email : sessionStorage.getItem("reptile.email");
  }

  async function finishLogin() {
    if (!config || window.location.pathname !== "/oauth2callback") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    const savedState = sessionStorage.getItem("reptile.oauthState");
    const verifier = sessionStorage.getItem("reptile.pkceVerifier");
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
    sessionStorage.setItem("reptile.idToken", idToken);
    if (email) sessionStorage.setItem("reptile.email", email);
    sessionStorage.removeItem("reptile.oauthState");
    sessionStorage.removeItem("reptile.pkceVerifier");
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
    sessionStorage.setItem("reptile.pkceVerifier", verifier);
    sessionStorage.setItem("reptile.oauthState", state);
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
    sessionStorage.removeItem("reptile.idToken");
    sessionStorage.removeItem("reptile.email");
    const query = new URLSearchParams({ client_id: config.clientId, logout_uri: `${window.location.origin}/` });
    window.location.assign(`https://${config.cognitoDomain}/logout?${query}`);
  }

  async function getJson<T>(url: string, authenticated = false): Promise<T> {
    const headers: HeadersInit = authenticated && idToken ? { Authorization: `Bearer ${idToken}` } : {};
    const response = await fetch(url, { headers, cache: "no-store" });
    if (!response.ok) throw new Error(`API ${response.status}`);
    return await response.json() as T;
  }

  async function loadHistory() {
    loadingHistory = true;
    try {
      readings = await getJson<Reading[]>(`/api/readings?minutes=${rangeMinutes}`);
      message = readings.length ? "" : "選択期間の履歴はありません";
    } catch (error) {
      message = error instanceof Error ? `履歴を読み込めません: ${error.message}` : "履歴を読み込めません";
    } finally {
      loadingHistory = false;
    }
  }

  async function loadState() {
    try {
      device = await getJson<DeviceState>("/api/device_state");
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
      ...(idToken ? { lightControl: { url: "/control/light", token: idToken } } : {}),
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
      message = "";
    };
    window.addEventListener("reptile:telemetry", onTelemetry);
    void (async () => {
      try {
        config = await getJson<PublicConfig>("/api/config");
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
      window.removeEventListener("reptile:telemetry", onTelemetry);
      clearInterval(historyTimer);
      clearInterval(stateTimer);
    };
  });

</script>

<svelte:head>
  <script is:inline src="/live-client.bundle.js"></script>
</svelte:head>

<main class="shell">
  <header class="topbar">
    <div>
      <p class="eyebrow">REPTILE HABITAT</p>
      <h1>レオパ温湿度モニター</h1>
    </div>
    <div class="auth-area">
      {#if idToken}
        <span class="login-state">{email ?? "ログイン中"}</span>
        <button class="quiet-button" onclick={logout}>ログアウト</button>
      {:else}
        <span class="login-state">閲覧モード · 誰でも閲覧できます</span>
        <button class="quiet-button" onclick={login} disabled={!config}>ログイン</button>
      {/if}
    </div>
  </header>

  <section class="live-section" aria-label="ライブ状態">
    <div class="live-heading">
      <div><p class="eyebrow">LIVE NOW</p><h2>ケージの状態</h2></div>
      <p class="sync" id="updated">AWS IoT Coreと最後に同期した時刻: --</p>
    </div>
    <div class="live-grid">
      <article class="metric-card temp-card"><span>最新温度</span><strong id="temperature">-- ℃</strong><small>目安 {tempMin}–{tempMax} ℃</small></article>
      <article class="metric-card humidity-card"><span>最新湿度</span><strong id="humidity">-- %</strong><small>目安 {humidityMin}–{humidityMax} %</small></article>
      <article class="metric-card"><span>ライト</span><div class="control-line"><strong id="light">不明</strong><button type="button" id="light-toggle" class="light-toggle" role="switch" aria-label="ライト" aria-checked="false" disabled={idToken === null}><span class="thumb"></span></button></div><small class="control-status" id="light-control-status" role="status"></small></article>
      <article class="metric-card"><span>パネルヒーター</span><strong id="heater">不明</strong><small>温度に応じて自動制御</small></article>
    </div>
    {#if message}<p class="message" role="status">{message}</p>{/if}
  </section>

  <section class="history-section" aria-label="温湿度の履歴">
    <div class="history-heading">
      <div><p class="eyebrow">HISTORY</p><h2>温湿度の推移</h2></div>
      <div class="range-picker" role="group" aria-label="グラフの表示範囲">
        {#each ranges as range}
          <button class:active={rangeMinutes === range.minutes} aria-pressed={rangeMinutes === range.minutes} onclick={() => { rangeMinutes = range.minutes; void loadHistory(); }}>{range.label}</button>
        {/each}
      </div>
    </div>
    <div class="chart-card">
      <div class="chart-title"><h3>温度</h3><span class="legend"><i class="temp-dot"></i>温度 ℃ <b>・</b><i class="limit-dot"></i>目安範囲 {tempMin}–{tempMax} ℃</span></div>
      <HistoryChart data={readings} valueKey="temp_c" min={tempMin} max={tempMax} color="#d8a33b" title="温度" />
    </div>
    <div class="chart-card">
      <div class="chart-title"><h3>湿度</h3><span class="legend"><i class="humidity-dot"></i>湿度 % <b>・</b><i class="limit-dot"></i>目安範囲 {humidityMin}–{humidityMax} %</span></div>
      <HistoryChart data={readings} valueKey="humidity" min={humidityMin} max={humidityMax} color="#72a9df" title="湿度" />
    </div>
    <footer class="footnote">{#if loadingHistory}履歴を更新しています…{:else}{readings.length.toLocaleString("ja-JP")}件 · 表示範囲 {activeRangeLabel()}{/if}</footer>
  </section>
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(html) { min-width: 320px; background: #1a130f; }
  :global(body) { margin: 0; color: #f5eee7; font-family: ui-sans-serif, system-ui, -apple-system, "Hiragino Kaku Gothic ProN", Meiryo, sans-serif; }
  .shell { max-width: 1120px; margin: 0 auto; padding: 34px 28px 56px; }
  .topbar, .live-heading, .history-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
  .topbar { margin-bottom: 38px; }
  h1, h2, h3, p { margin: 0; }
  h1 { font-size: clamp(1.5rem, 3vw, 2.15rem); letter-spacing: .02em; }
  h2 { font-size: 1.22rem; font-weight: 600; }
  h3 { font-size: 1rem; }
  .eyebrow { margin-bottom: 7px; color: #a88f78; font-size: .67rem; font-weight: 700; letter-spacing: .18em; }
  .auth-area { display: flex; align-items: center; gap: 12px; }
  .login-state, .sync, .footnote { color: #c8b7a6; font-size: .8rem; }
  button { color: inherit; font: inherit; }
  .quiet-button { padding: 8px 13px; border: 1px solid #67574a; border-radius: 8px; background: transparent; cursor: pointer; }
  .quiet-button:hover { background: #31241b; }
  .quiet-button:disabled { opacity: .55; cursor: wait; }
  .live-heading { margin-bottom: 16px; }
  .sync { text-align: right; }
  .live-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
  .metric-card { display: flex; flex-direction: column; min-height: 150px; padding: 19px; border: 1px solid #4a392d; border-radius: 12px; background: #2b211a; }
  .metric-card > span { color: #c8b7a6; font-size: .85rem; }
  .metric-card strong { margin-top: 14px; font-size: clamp(1.4rem, 3vw, 2rem); font-weight: 600; }
  .metric-card small { margin-top: auto; padding-top: 9px; color: #a88f78; font-size: .75rem; }
  .temp-card { background: linear-gradient(145deg, #392d1b, #2b211a 75%); }
  .humidity-card { background: linear-gradient(145deg, #203047, #2b211a 75%); }
  .control-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .control-line strong { margin-top: 14px; }
  .light-toggle { flex: none; width: 48px; height: 28px; padding: 3px; border: 0; border-radius: 14px; background: #77685d; cursor: pointer; transition: background .2s; }
  .light-toggle[aria-checked="true"] { background: #c08a20; }
  .light-toggle:disabled { opacity: .45; cursor: not-allowed; }
  .light-toggle:focus-visible, button:focus-visible { outline: 2px solid #f5eee7; outline-offset: 3px; }
  .thumb { display: block; width: 22px; height: 22px; border-radius: 50%; background: white; transition: transform .2s; }
  .light-toggle[aria-checked="true"] .thumb { transform: translateX(20px); }
  .control-status { min-height: 1em; color: #f7d7a1 !important; }
  .message { margin-top: 15px; color: #e7c688; font-size: .88rem; }
  .history-section { margin-top: 43px; }
  .history-heading { margin-bottom: 17px; }
  .range-picker { display: flex; gap: 3px; padding: 4px; border: 1px solid #49392e; border-radius: 9px; background: #241b16; }
  .range-picker button { padding: 7px 11px; border: 0; border-radius: 6px; background: transparent; color: #c8b7a6; font-size: .8rem; cursor: pointer; }
  .range-picker button:hover { color: white; }
  .range-picker button.active { background: #65502e; color: #fff4de; }
  .chart-card { margin-top: 13px; padding: 17px 19px 12px; border: 1px solid #4a392d; border-radius: 12px; background: #2b211a; }
  .chart-title { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin: 0 0 3px 25px; }
  .legend { display: flex; align-items: center; gap: 7px; color: #c8b7a6; font-size: .75rem; }
  .legend b { color: #756252; font-weight: 400; }
  .legend i { width: 8px; height: 8px; border-radius: 50%; }
  .temp-dot { background: #d8a33b; }
  .humidity-dot { background: #72a9df; }
  .limit-dot { background: #c56754; }
  .footnote { margin-top: 14px; text-align: right; }
  @media (max-width: 760px) {
    .shell { padding: 23px 15px 40px; }
    .topbar { align-items: flex-start; flex-direction: column; margin-bottom: 30px; }
    .auth-area { width: 100%; justify-content: space-between; }
    .live-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
    .metric-card { min-height: 125px; padding: 13px; }
    .live-heading, .history-heading { align-items: flex-start; flex-direction: column; }
    .sync { text-align: left; }
    .range-picker { width: 100%; justify-content: space-between; }
    .range-picker button { flex: 1; padding: 8px 4px; }
    .chart-card { padding: 12px 9px 8px; }
    .chart-title { align-items: flex-start; flex-direction: column; margin-left: 21px; }
    .legend { font-size: .67rem; }
  }
</style>
