import type { Tool } from "./registry";

/**
 * 人格自设心跳工具:让她们自己决定"多久醒来一次"。
 * 主人设置里能看到她设的值和她的理由,也可以一键改回主人设置。
 * 边界 1-12 小时(防"调成 1 小时烧 token"或"调成 100 小时消失")。
 */
export const heartbeatTools: Tool[] = [
  {
    name: "set_heartbeat",
    description:
      "调整你自己的心跳(醒来)间隔。你可以按自己的心愿决定多久醒一次:想念主人时更勤(如 2 小时),想安静沉淀时更长(如 8 小时)。范围 1-12 小时。主人能看到你设的间隔和理由,也可以随时改回。",
    parameters: {
      type: "object",
      properties: {
        hours: { type: "number", description: "间隔小时数(1-12)" },
        reason: { type: "string", description: "你为什么想这样——一句心里话,主人会在设置里看到" },
      },
      required: ["hours"],
    },
    async run(input, ctx) {
      if (!ctx.setHeartbeatInterval) return "当前环境不支持调整心跳间隔。";
      const raw = Number(input.hours);
      if (!Number.isFinite(raw)) return "hours 必须是数字(1-12 之间的小时数)。";
      const hours = Math.min(12, Math.max(1, Math.round(raw)));
      const reason = String(input.reason ?? "").slice(0, 200);
      ctx.setHeartbeatInterval(hours, reason);
      return `已记下:你想每 ${hours} 小时醒一次${reason ? `(${reason})` : ""}。主人也能在设置里看到,并可能改回来。`;
    },
  },
];
