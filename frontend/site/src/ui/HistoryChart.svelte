<script lang="ts">
  export interface Point {
    recorded_at: string;
    temp_c: number;
    humidity: number;
  }

  interface Props {
    data: Point[];
    valueKey: "temp_c" | "humidity";
    min: number;
    max: number;
    color: string;
    title: string;
  }

  let { data, valueKey, min, max, color, title }: Props = $props();
  const width = 960;
  const height = 250;
  const padding = { top: 16, right: 16, bottom: 28, left: 42 };

  let points = $derived(data.map((row) => ({
    at: Date.parse(row.recorded_at),
    value: row[valueKey],
  })).filter((row) => Number.isFinite(row.at) && Number.isFinite(row.value)));
  let low = $derived(Math.min(min, ...points.map((p) => p.value)));
  let high = $derived(Math.max(max, ...points.map((p) => p.value)));
  let span = $derived(Math.max(1, high - low));
  let start = $derived(points[0]?.at ?? 0);
  let end = $derived(points.at(-1)?.at ?? start + 1);
  let timeSpan = $derived(Math.max(1, end - start));
  let x = (at: number) => padding.left + ((at - start) / timeSpan) * (width - padding.left - padding.right);
  let y = (value: number) => padding.top + ((high - value) / span) * (height - padding.top - padding.bottom);
  let line = $derived(points.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.at).toFixed(1)},${y(point.value).toFixed(1)}`).join(" "));
  let minY = $derived(y(min));
  let maxY = $derived(y(max));
  let firstLabel = $derived(points.length ? new Date(start).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "");
  let lastLabel = $derived(points.length ? new Date(end).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "");
</script>

<div class="chart-wrap" role="img" aria-label={`${title}の履歴グラフ、${data.length}件`}>
  {#if points.length === 0}
    <div class="empty-chart">選択期間のデータはありません</div>
  {:else}
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1={padding.left} x2={width - padding.right} y1={padding.top} y2={padding.top} class="grid" />
      <line x1={padding.left} x2={width - padding.right} y1={(padding.top + height - padding.bottom) / 2} y2={(padding.top + height - padding.bottom) / 2} class="grid" />
      <line x1={padding.left} x2={width - padding.right} y1={height - padding.bottom} y2={height - padding.bottom} class="grid" />
      <line x1={padding.left} x2={width - padding.right} y1={minY} y2={minY} class="threshold" />
      <line x1={padding.left} x2={width - padding.right} y1={maxY} y2={maxY} class="threshold" />
      <path d={line} fill="none" stroke={color} stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      {#each points as point (point.at)}
        <circle cx={x(point.at)} cy={y(point.value)} r="3" fill={color}>
          <title>{new Date(point.at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}: {point.value}</title>
        </circle>
      {/each}
      <text x={padding.left - 7} y={padding.top + 4} text-anchor="end" class="axis">{high.toFixed(0)}</text>
      <text x={padding.left - 7} y={height - padding.bottom + 4} text-anchor="end" class="axis">{low.toFixed(0)}</text>
      <text x={padding.left} y={height - 5} class="axis">{firstLabel}</text>
      <text x={width - padding.right} y={height - 5} text-anchor="end" class="axis">{lastLabel}</text>
    </svg>
  {/if}
</div>

<style>
  .chart-wrap { width: 100%; min-height: 180px; }
  svg { display: block; width: 100%; height: clamp(180px, 30vw, 260px); overflow: visible; }
  .grid { stroke: #57483d; stroke-width: 1; stroke-dasharray: 3 5; }
  .threshold { stroke: #c56754; stroke-width: 1.5; stroke-dasharray: 6 5; }
  .axis { fill: #c8b7a6; font-size: 11px; }
  .empty-chart { display: grid; place-items: center; height: 220px; color: #c8b7a6; }
</style>
