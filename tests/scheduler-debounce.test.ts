import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../server/storage";
import { Scheduler } from "../server/tasks";
import type { AgentDef, TaskDef } from "../shared/types";

/** 回归测试:心跳执行完写回任务时,绝不能把 tick 防抖写入的未来 nextRunAt 覆盖回过去。
 *  曾因 saveTask({...旧task}) 覆盖 → 下一 tick 立即再次触发 → 十几秒一跳疯狂循环。 */
describe("scheduler nextRunAt 防抖保留", () => {
  let db: Db;
  let dir: string;
  const agent: AgentDef = {
    id: "agent_test",
    name: "测试人格",
    description: "",
    systemPrompt: "你是测试人格",
    memoryEnabled: true,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hanalite-sched-"));
    db = new Db(dir);
    db.saveAgent(agent);
  });

  function makeHeartbeatTask(over: Partial<TaskDef> = {}): TaskDef {
    return {
      id: "t_hb",
      name: "心跳",
      prompt: "",
      schedule: "0 3 * * *",
      agentId: agent.id,
      enabled: true,
      createdAt: Date.now(),
      nextRunAt: Date.now() - 1000, // 已到期,下一 tick 应触发
      ...over,
    };
  }

  it("心跳执行后 nextRunAt 保持为未来(不被旧值覆盖)", async () => {
    const task = makeHeartbeatTask();
    db.saveTask(task);
    // engine mock:runChat 立即回调 done(空产出),模拟"安静地待了一会儿"
    const engine = {
      runChat: async (_s: unknown, _a: unknown, _m: unknown, onEvent: (e: unknown) => void) => {
        onEvent({ type: "done", message: { parts: [] } });
      },
    } as never;
    const sched = new Scheduler(db, engine as never, () => agent, undefined, dir);
    await sched.tick();
    const after = db.getTask("t_hb")!;
    // 防抖后的 nextRunAt 至少是 1 小时后(默认 3h 间隔),绝不能再是"过去"
    expect(after.nextRunAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
    // 再跑一次 tick 不应再次触发(任务未到期)
    const before = after.nextRunAt;
    await sched.tick();
    expect(db.getTask("t_hb")!.nextRunAt).toBe(before);
  });

  it("cron 任务执行后同样保留防抖的 nextRunAt", async () => {
    const task: TaskDef = {
      id: "t_cron",
      name: "闹钟",
      prompt: "你好",
      schedule: "0 3 * * *",
      agentId: agent.id,
      enabled: true,
      createdAt: Date.now(),
      nextRunAt: Date.now() - 1000,
    };
    db.saveTask(task);
    const engine = {
      runChat: async (_s: unknown, _a: unknown, _m: unknown, onEvent: (e: unknown) => void) => {
        onEvent({ type: "done", message: { parts: [{ type: "text", text: "ok" }] } });
      },
    } as never;
    const sched = new Scheduler(db, engine as never, () => agent, undefined, dir);
    await sched.tick();
    const after = db.getTask("t_cron")!;
    expect(after.nextRunAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
  });
});
