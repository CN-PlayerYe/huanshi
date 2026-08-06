import type { AgentDef, StreamEvent, TaskDef } from "../shared/types";
import type { AgentEngine } from "./agent/engine";
import { nextRunTime, parseCron } from "./cron";
import type { Db } from "./storage";

/**
 * 定时任务调度器:周期性检查到期任务,后台交给 Agent 引擎执行。
 * 不阻塞主流程,结果写入任务记录。
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
    private onDone?: (e: { taskName: string; ok: boolean; result: string }) => void,
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
      if (task.nextRunAt > now) continue;
      this.running.add(task.id);
      // 防抖:立即把 nextRunAt 推到下次,避免异常导致死循环
      const next = this.computeNext(task.schedule);
      this.db.saveTask({ ...task, nextRunAt: next ?? task.nextRunAt + 60_000, lastStatus: "running" });
      void this.runTask(task).finally(() => this.running.delete(task.id));
    }
  }

  /** 计算下一次执行时间(基于当前时间 + 1 分钟) */
  computeNext(expr: string): number | null {
    try {
      const d = nextRunTime(parseCron(expr), new Date(Date.now() + 60_000));
      return d ? d.getTime() : null;
    } catch {
      return null;
    }
  }

  private async runTask(task: TaskDef): Promise<void> {
    const agent = this.getAgent(task.agentId);
    if (!agent) {
      this.db.saveTask({ ...task, lastStatus: "error", lastResult: `人格不存在:${task.agentId}`, lastRunAt: Date.now() });
      return;
    }
    try {
      const session = this.db.createSession(`⏰ ${task.name}`, task.agentId);
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
      await this.engine.runChat(session, agent, task.prompt, onEvent);
      this.db.saveTask({
        ...task,
        lastRunAt: Date.now(),
        lastStatus: "ok",
        lastResult: finalText || "(无文本输出)",
      });
      this.onDone?.({ taskName: task.name, ok: true, result: finalText || "" });
    } catch (err) {
      this.db.saveTask({
        ...task,
        lastRunAt: Date.now(),
        lastStatus: "error",
        lastResult: `执行失败:${(err as Error).message}`,
      });
      this.onDone?.({ taskName: task.name, ok: false, result: (err as Error).message });
    }
  }
}
