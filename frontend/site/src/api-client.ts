import { hc } from "hono/client";
import type { AppType } from "../../../../reptile-iot-cdk/lambda/api";

export const apiClient = hc<AppType>("/");
