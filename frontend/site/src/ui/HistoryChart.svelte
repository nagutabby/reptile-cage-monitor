<script lang="ts">
  import { Chart, LineController, LineElement, PointElement, LinearScale, Tooltip, Filler } from "chart.js";
  import { onMount } from "svelte";

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

  Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip, Filler);

  let { data, valueKey, min, max, color, title }: Props = $props();
  let canvas: HTMLCanvasElement;
  let chart: Chart<"line", { x: number; y: number }[]> | undefined;

  const timeFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
  const fullFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "medium" });

  let points = $derived(data
    .map((row) => ({ x: Date.parse(row.recorded_at), y: row[valueKey] }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));

  onMount(() => {
    chart = new Chart(canvas, {
      type: "line",
      data: { datasets: [{ data: [], borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 2, tension: 0.2 }] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: (items) => fullFormat.format(items[0].parsed.x ?? 0) } },
        },
        scales: {
          x: {
            type: "linear",
            ticks: { color: "#a0a4b8", maxTicksLimit: 6, callback: (value) => timeFormat.format(Number(value)) },
            grid: { color: "rgba(98, 114, 164, .25)" },
          },
          y: { ticks: { color: "#a0a4b8" }, grid: { color: "rgba(98, 114, 164, .25)" } },
        },
      },
    });
    return () => chart?.destroy();
  });

  $effect(() => {
    if (!chart) return;
    const values = points.map((p) => p.y);
    chart.data.datasets[0].data = points;
    chart.options.scales!.y!.min = Math.min(min, ...values);
    chart.options.scales!.y!.max = Math.max(max, ...values);
    chart.update();
  });
</script>

<div class="relative h-56 w-full sm:h-64" role="img" aria-label={`${title}の履歴グラフ、${data.length}件`}>
  <canvas bind:this={canvas}></canvas>
  {#if points.length === 0}
    <div class="absolute inset-0 grid place-items-center text-base-content/60">選択期間のデータはありません</div>
  {/if}
</div>
