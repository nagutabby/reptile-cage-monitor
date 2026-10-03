import { hc } from "hono/client";
import type { AppType } from "../../../lambda/api";

export const apiClient = hc<AppType>("/");
