import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emulatorHost, readDesired, resetShadow, writeDesired } from "./helpers";

type Schedule = typeof import("../../lambda/light-schedule");
let schedule: Schedule;

// 日本時間 2026-10-07 の 07:00 / 19:00 から 30 秒後
const JST_0700 = Date.parse("2026-10-06T22:00:00Z");
const JST_1900 = Date.parse("2026-10-07T10:00:00Z");
const at = (epochMs: number) => vi.setSystemTime(epochMs + 30_000);

beforeAll(async () => {
  process.env.IOT_ENDPOINT = emulatorHost();
  schedule = await import("../../lambda/light-schedule");
});

beforeEach(async () => {
  await resetShadow();
  // 通信のタイマーは実時間のまま、Date だけを固定する。署名時刻がずれても AWS SDK がサーバーの
  // Date ヘッダーから補正して再試行するため、エミュレータとの通信は成立する
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("light schedule against AWS Emulator", () => {
  it("turns the light on at 07:00 and off at 19:00 Japan time", async () => {
    at(JST_0700);
    expect(await schedule.handler({ hour: 7 })).toEqual({ status: "updated" });
    expect(await readDesired()).toEqual({ is_light_on: true, light_command_at: JST_0700 });

    at(JST_1900);
    expect(await schedule.handler({ hour: 19 })).toEqual({ status: "updated" });
    expect(await readDesired()).toEqual({ is_light_on: false, light_command_at: JST_1900 });
  });

  it("is idempotent when the same schedule event is delivered twice", async () => {
    at(JST_0700);
    await schedule.handler({ hour: 7 });

    expect(await schedule.handler({ hour: 7 })).toEqual({ status: "unchanged" });
  });

  it("ignores an event that was superseded by a newer light command", async () => {
    await writeDesired({ is_light_on: false, light_command_at: JST_0700 + 60_000 });
    at(JST_0700);

    expect(await schedule.handler({ hour: 7 })).toEqual({ status: "superseded" });
    expect(await readDesired()).toEqual({ is_light_on: false, light_command_at: JST_0700 + 60_000 });
  });

  it("rejects an invalid hour and an event outside its five-minute window", async () => {
    at(JST_0700);
    await expect(schedule.handler({ hour: 8 })).rejects.toThrow("Invalid light schedule hour");
    await expect(schedule.handler({})).rejects.toThrow("Invalid light schedule hour");

    vi.setSystemTime(JST_0700 + 301_000);
    await expect(schedule.handler({ hour: 7 })).rejects.toThrow("outside its five-minute window");
    vi.setSystemTime(JST_0700 + 300_000);
    expect(await schedule.handler({ hour: 7 })).toEqual({ status: "updated" });
  });
});
