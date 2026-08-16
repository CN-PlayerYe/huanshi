import type { AgentDef, StreamEvent, TaskDef } from "../shared/types";
import type { AgentEngine } from "./agent/engine";
import type { ChatRunOpts } from "./agent/engine";
import { nextRunTime, parseCron } from "./cron";
import type { Db } from "./storage";
import { mergeHeartbeat, inQuietWindow, nextHeartbeatAt, buildHeartbeatMessage, scanAgentSpace, readFootprint, effectiveInterval } from "./heartbeat";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 定时任务调度器:周期性检查到期任务,后台交给 Agent 引擎执行。
 * 不阻塞主流程,结果写入任务记录。支持两种任务:
 * - cron:闹钟,到点执行固定提示词
 * - heartbeat:心跳,到点生成动态消息(「你自由了」),让人格自主活动
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();
  private stopped = false;

  constructor(
    private db: Db,
    private engine: AgentEngine,
    private getAgent: (id: string) => AgentDef | undefined,
    /** 任务执行完成回调(用于桌面通知) */
    private onDone?: (e: { taskName: string; ok: boolean; result: string; sessionId?: string }) => void,
    private workspaceDir = "workspace",
    /** 主人最近一次发消息的时间(心跳打断用) */
    private lastUserAtFn?: () => number | undefined,
    /** 全局暂停心跳:返回 true 时所有心跳任务安静 */
    private isHeartbeatPaused?: () => boolean,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 15_000);
    // 启动时先补跑一次,避免刚启动错过时间点
    setTimeout(() => void this.tick(), 2_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    for (const task of this.db.listTasks()) {
      if (!task.enabled || this.running.has(task.id)) continue;
      if (task.kind === "heartbeat" && this.isHeartbeatPaused?.()) continue; // 全局暂停
      if (task.nextRunAt > now) continue;
      this.running.add(task.id);
      // 防抖:立即把 nextRunAt 推到下次,避免异常导致死循环
      const next = this.computeNext(task);
      this.db.saveTask({ ...task, nextRunAt: next ?? task.nextRunAt + 60_000, lastStatus: "running" });
      void this.runTask(task).finally(() => this.running.delete(task.id));
    }
  }

  /** 保存任务但保留最新 nextRunAt(防抖写入的未来值)。
   *  直接展开旧 task 会把 nextRunAt 覆盖回过去 → 下个 tick 立即再次触发 → 心跳/定时疯狂循环。
   *  所有"执行完写回"都必须走这里。 */
  private saveFresh(id: string, patch: Record<string, unknown>): void {
    const cur = this.db.getTask(id);
    if (!cur) return;
    this.db.saveTask({ ...cur, ...patch } as TaskDef);
  }

  /** 计算下一次执行时间(cron 任务按 cron;心跳任务按动态间隔+静默时段) */
  computeNext(task: TaskDef): number | null {
    if (task.kind === "heartbeat") {
      const hb = mergeHeartbeat(task.heartbeat);
      return nextHeartbeatAt(new Date(Date.now() + 60_000), hb, {
        blankBeats: task.blankBeats ?? 0,
        lastUserAt: this.lastUserAtFn?.(),
      }).getTime();
    }
    try {
      const d = nextRunTime(parseCron(task.schedule), new Date(Date.now() + 60_000));
      return d ? d.getTime() : null;
    } catch {
      return null;
    }
  }

  /** 手动立即运行(设置页「▶ 立即运行」):按任务类型走正确分支 */
  async runNow(taskId: string): Promise<{ ok: boolean; result: string }> {
    const task = this.db.getTask(taskId);
    if (!task) return { ok: false, result: "任务不存在" };
    const agent = this.getAgent(task.agentId);
    if (!agent) return { ok: false, result: "人格不存在" };
    let result = "";
    await this.runTask(task, agent);
    const cur = this.db.getTask(taskId);
    if (cur) result = cur.lastResult || "";
    return { ok: true, result };
  }

  private async runTask(task: TaskDef, agent?: AgentDef): Promise<void> {
    const a = agent ?? this.getAgent(task.agentId);
    if (!a) {
      this.saveFresh(task.id, { lastStatus: "error", lastResult: `人格不存在:${task.agentId}`, lastRunAt: Date.now() });
      return;
    }
    try {
      if (task.kind === "heartbeat") {
        await this.runHeartbeat(task, a);
        return;
      }
      // 固定会话:任务首次运行创建会话并记在 task 上,之后持续追加(自由活动/简报都能连续,不再攒「⏰」碎片)
      let session = task.sessionId ? this.db.getSession(task.sessionId) : undefined;
      if (!session) {
        session = this.db.createSession(`⏰ ${task.name}`, task.agentId);
        this.saveFresh(task.id, { sessionId: session.id });
        task = { ...task, sessionId: session.id };
      }
      let finalText = "";
      const onEvent = (e: StreamEvent) => {
        if (e.type === "done") {
          finalText = e.message.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n")
            .slice(0, 600);
        }
      };
      await this.engine.runChat(session, a, task.prompt, onEvent);
      this.saveFresh(task.id, {
        lastRunAt: Date.now(),
        lastStatus: "ok",
        lastResult: finalText || "(无文本输出)",
      });
      this.onDone?.({ taskName: task.name, ok: true, result: finalText || "", sessionId: session.id });
    } catch (err) {
      this.saveFresh(task.id, {
        lastRunAt: Date.now(),
        lastStatus: "error",
        lastResult: `执行失败:${(err as Error).message}`,
      });
      this.onDone?.({ taskName: task.name, ok: false, result: (err as Error).message });
    }
  }

  /**
   * 心跳执行:系统动态生成心跳消息(不是任务书),按安全边界裁剪工具,
   * 到时长自动收工,主人发消息立即打断。心跳写入该任务固定的
   * 「💓 心跳日记」会话(不产生碎片),便于主人随时翻阅。
   */
  async runHeartbeat(task: TaskDef, agent: AgentDef): Promise<void> {
    const hb = mergeHeartbeat(task.heartbeat);
    const now = new Date();
    const agentSpace = join(this.workspaceDir, agent.name);
    const spaceStatus = scanAgentSpace(agentSpace);
    const footprint = readFootprint(agentSpace);
    // 睡前跳:bedtimeHour 后的第一次心跳(距上次心跳跨过 bedtimeHour)
    const prevHour = task.lastRunAt ? new Date(task.lastRunAt).getHours() : -1;
    const isBedtime = now.getHours() >= hb.bedtimeHour && prevHour < hb.bedtimeHour;
    const message = buildHeartbeatMessage({
      now,
      lastBeatAt: task.lastRunAt,
      lastUserAt: this.lastUserAtFn?.(),
      spaceStatus,
      homeDir: agentSpace,
      footprint,
      isBedtime,
      agent,
    });

    // 固定心跳日记会话:首次创建并记在任务上,之后每次追加
    let session = task.sessionId ? this.db.getSession(task.sessionId) : undefined;
    if (!session) {
      session = this.db.createSession(`💓 ${agent.name} 心跳日记`, task.agentId);
      this.saveFresh(task.id, { sessionId: session.id });
      task = { ...task, sessionId: session.id };
    }

    // 安全边界 → 工具过滤与权限覆盖
    const opts: ChatRunOpts = {
      readOnly: hb.scope === "self",
      allowNetwork: hb.network !== "off",
      allowCommands: hb.commands !== "off",
      allowDangerousCommands: hb.commands === "allow",
      // 心跳是自主活动,不需要全量历史:固定只发最近 40 条(不跟随人格 100% 全量,大幅省输入成本)
      historyLimit: 40,
    };
    if (hb.scope === "self") {
      mkdirSync(agentSpace, { recursive: true });
      opts.cwd = agentSpace;
      opts.allowedWriteDirs = [agentSpace];
      opts.unrestrictedPaths = false;
    } else if (hb.scope === "workspace") {
      opts.cwd = this.workspaceDir;
      opts.allowedWriteDirs = [this.workspaceDir];
      opts.unrestrictedPaths = false;
    }

    // 超时:到点自动收工
    const ctrl = new AbortController();
    const maxMs = Math.max(1, hb.maxMinutes) * 60_000;
    const timer = setTimeout(() => ctrl.abort(), maxMs);

    // 主人插话打断:主人有新消息则立即收工
    let interruptTimer: ReturnType<typeof setInterval> | null = null;
    if (hb.interruptible) {
      const startedAt = Date.now();
      interruptTimer = setInterval(() => {
        const lastUser = this.lastUserAtFn?.();
        if (lastUser && lastUser > startedAt) {
          ctrl.abort();
          if (interruptTimer) clearInterval(interruptTimer);
        }
      }, 5_000);
    }

    let finalText = "";
    try {
      const onEvent = (e: StreamEvent) => {
        if (e.type === "done") {
          finalText = e.message.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n")
            .slice(0, 400);
        }
      };
      await this.engine.runChat(session, agent, message, onEvent, ctrl.signal, undefined, opts);
      const interrupted = ctrl.signal.aborted;
      // 产出检测(心跳规格 §一):有自发产出 → 空跳清零;无事发生 → 空跳 +1(下次间隔翻倍)
      const hasOutput = !interrupted && finalText.trim().length > 20;
      const blankBeats = hasOutput ? 0 : (task.blankBeats ?? 0) + 1;
      this.saveFresh(task.id, {
        lastRunAt: Date.now(),
        lastStatus: "ok",
        lastResult: interrupted ? "(被主人打断,已收工)" : finalText || "(安静地待了一会儿)",
        blankBeats,
      });
      this.onDone?.({ taskName: task.name, ok: true, result: finalText || "安静活动", sessionId: task.sessionId });
    } catch (err) {
      const aborted = ctrl.signal.aborted;
      this.saveFresh(task.id, {
        lastRunAt: Date.now(),
        lastStatus: aborted ? "ok" : "error",
        lastResult: aborted ? "(到点/被打断,自动收工)" : `执行失败:${(err as Error).message}`,
      });
    } finally {
      clearTimeout(timer);
      if (interruptTimer) clearInterval(interruptTimer);
    }
  }
}
