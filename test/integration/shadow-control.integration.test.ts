import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emulatorHost, readDesired, resetShadow, writeDesired } from "./helpers";

type Shadow = typeof import("../../lambda/shadow-control");
let shadow: Shadow;

beforeAll(async () => {
  process.env.IOT_ENDPOINT = emulatorHost();
  shadow = await import("../../lambda/shadow-control");
});

beforeEach(() => resetShadow());

describe("shadow control against AWS Emulator", () => {
  it("treats a missing shadow as empty", async () => {
    expect(await shadow.getShadow()).toEqual({ state: {} });
  });

  it("creates the shadow on the first update", async () => {
    expect(await shadow.updateDesired({ is_heater_on: true })).toEqual({ status: "updated" });
    expect(await readDesired()).toEqual({ is_heater_on: true });
  });

  it("applies concurrent updates by retrying on shadow version conflicts", async () => {
    await writeDesired({ seed: true });

    const results = await Promise.all(
      ["a", "b", "c"].map((key) => shadow.updateDesired({ [key]: true })),
    );

    expect(results).toEqual([{ status: "updated" }, { status: "updated" }, { status: "updated" }]);
    expect(await readDesired()).toEqual({ seed: true, a: true, b: true, c: true });
  });
});
