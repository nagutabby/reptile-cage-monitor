import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMonitorTable } from "./helpers";

const TABLE_NAME = "integration-alert-data";
const LINE_TOKEN = "integration-line-token";
const LINE_TO = "integration-line-destination";
const ALERT_KEY = { pk: "ALERT", sk: "ENVIRONMENT" };
const HOUR_MS = 60 * 60 * 1000;

type Ingest = typeof import("../../lambda/ingest");
type Database = typeof import("../../lambda/database");
let ingest: Ingest;
let ddb: Database["ddb"];
let lineRequests: Array<{ url: string; init: RequestInit }>;
let lineStatus = 200;

// イベントごとに observed_at を進める。ingest は評価済みより古い observed_at を無視するため
let tick = 0;
const BASE_MS = Date.now();
const event = (tempC: number, humidity = 60) => ({
  event_id: `e-${tick}`,
  observed_at: new Date(BASE_MS + 1_000 * ++tick).toISOString(),
  temp_c: tempC,
  humidity,
});

const alertState = async () => (await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: ALERT_KEY }))).Item;

beforeAll(async () => {
  process.env.TABLE_NAME = TABLE_NAME;
  process.env.LINE_TOKEN_PARAMETER = "/integration/line/token";
  process.env.LINE_TO_ID_PARAMETER = "/integration/line/to";
  ingest = await import("../../lambda/ingest");
  ({ ddb } = await import("../../lambda/database"));

  await createMonitorTable(TABLE_NAME);
  const ssm = new SSMClient({});
  for (const [name, value] of [[process.env.LINE_TOKEN_PARAMETER, LINE_TOKEN], [process.env.LINE_TO_ID_PARAMETER, LINE_TO]]) {
    await ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: "SecureString" }));
  }

  // LINE の API だけを差し替える。AWS SDK は fetch を使わないので、エミュレータとの通信には影響しない
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.line.me/")) return realFetch(input, init);
    lineRequests.push({ url, init: init ?? {} });
    return new Response("{}", { status: lineStatus });
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  lineRequests = [];
  lineStatus = 200;
  await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: ALERT_KEY }));
});

describe("LINE alerts against AWS Emulator", () => {
  it("sends one push with the SSM credentials on the first abnormal reading", async () => {
    await ingest.handler(event(35));

    expect(lineRequests).toHaveLength(1);
    const [{ url, init }] = lineRequests;
    expect(url).toBe("https://api.line.me/v2/bot/message/push");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${LINE_TOKEN}`);
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe(LINE_TO);
    expect(body.messages[0].text).toContain("温度: 35.0C");

    expect(await alertState()).toMatchObject({ is_abnormal: true });
    expect((await alertState())?.last_alert_at).toBeGreaterThan(Date.now() - 60_000);
  });

  it("does not notify for readings inside the limits", async () => {
    await ingest.handler(event(27, 50));

    expect(lineRequests).toHaveLength(0);
    expect(await alertState()).toMatchObject({ is_abnormal: false });
  });

  it("suppresses repeats within an hour and resends after it", async () => {
    await ingest.handler(event(35));
    const firstAlertAt = (await alertState())?.last_alert_at as number;
    await ingest.handler(event(36));
    expect(lineRequests).toHaveLength(1);
    expect((await alertState())?.last_alert_at).toBe(firstAlertAt);

    // 前回の通知を 1 時間前にずらす
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...(await alertState()), last_alert_at: Date.now() - HOUR_MS - 1_000 },
    }));
    await ingest.handler(event(37));
    expect(lineRequests).toHaveLength(2);
    expect((await alertState())?.last_alert_at).toBeGreaterThan(firstAlertAt);
  });

  it("keeps suppressing just inside the one-hour window", async () => {
    await ingest.handler(event(35));
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...(await alertState()), last_alert_at: Date.now() - HOUR_MS + 30_000 },
    }));

    await ingest.handler(event(36));
    expect(lineRequests).toHaveLength(1);
  });

  it("notifies again right away when a recovered environment turns abnormal again", async () => {
    await ingest.handler(event(35));
    await ingest.handler(event(27, 50));
    expect(await alertState()).toMatchObject({ is_abnormal: false });
    await ingest.handler(event(35));

    expect(lineRequests).toHaveLength(2);
  });

  it("alerts on humidity alone", async () => {
    await ingest.handler(event(27, 95));

    expect(lineRequests).toHaveLength(1);
    expect(JSON.parse(lineRequests[0].init.body as string).messages[0].text).toContain("湿度: 95%");
  });

  it("ignores a reading older than the one already evaluated", async () => {
    const newer = event(27, 50);
    const older = event(35);
    await ingest.handler(newer);
    // older は newer より前の observed_at を持つ
    await ingest.handler({ ...older, observed_at: new Date(Date.parse(newer.observed_at) - 5_000).toISOString() });

    expect(lineRequests).toHaveLength(0);
    expect(await alertState()).toMatchObject({ is_abnormal: false, evaluated_at: expect.any(String) });
  });

  it("releases the reservation when LINE fails so the next reading notifies", async () => {
    lineStatus = 500;
    await expect(ingest.handler(event(35))).rejects.toThrow("LINE push failed with status 500");
    expect(lineRequests).toHaveLength(1);
    const afterFailure = await alertState();
    expect(afterFailure).toMatchObject({ is_abnormal: false });
    expect(afterFailure?.last_alert_at).toBeUndefined();

    lineStatus = 200;
    await ingest.handler(event(35));
    expect(lineRequests).toHaveLength(2);
    expect(await alertState()).toMatchObject({ is_abnormal: true });
  });

  it("restores the previous alert time when a resend fails", async () => {
    await ingest.handler(event(35));
    const previous = await alertState();
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...previous, last_alert_at: Date.now() - HOUR_MS - 1_000 },
    }));
    const staleAlertAt = (await alertState())?.last_alert_at;

    lineStatus = 500;
    await expect(ingest.handler(event(36))).rejects.toThrow("LINE push failed");

    expect(await alertState()).toMatchObject({ is_abnormal: true, last_alert_at: staleAlertAt });
  });

  it("sends a single push when several abnormal readings arrive at the same time", async () => {
    const results = await Promise.allSettled([event(35), event(36), event(37)].map((value) => ingest.handler(value)));

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(lineRequests).toHaveLength(1);
  });
});
