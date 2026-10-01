import { scheduledEpochMs, updateDesired } from "./shadow-control";

interface ScheduleEvent {
  hour?: number;
}

export async function handler(event: ScheduleEvent): Promise<{ status: string }> {
  if (event.hour !== 7 && event.hour !== 19) throw new Error("Invalid light schedule hour");
  const now = new Date();
  const scheduledAt = scheduledEpochMs(now, event.hour);
  if (Math.abs(now.getTime() - scheduledAt) > 300_000) {
    throw new Error("Light schedule event arrived outside its five-minute window");
  }
  return updateDesired(
    { is_light_on: event.hour === 7, light_command_at: scheduledAt },
    { commandAt: scheduledAt },
  );
}
