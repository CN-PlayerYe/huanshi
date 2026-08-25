import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../server/storage";
import { Scheduler } from "../server/tasks";
import type { AgentDef, TaskDef } from "../shared/types";

const agent: AgentDef = {
  id: "agent_test",
  name: "测试人格",
  description: "",
  systemPrompt: "你是测试人格",
  memoryEnabled: true,
};

function makeHeartbeatTask(over: Partial<TaskDef> = {}): TaskDef {
  return {
    id: "t_hb",
    name: "心跳",
    kind: "heartbeat",
    prompt: "",
    schedule: "0 3 * * *",
    agentId: agent.id,
    enabled: true,
    createdAt: Date.now(),
    nextRunAt: Date.now() - 1000, // 已到期,下一 tick 应触发
    ...over,
  };
}

/** 回归测试:心跳执行完写回任务时,绝不能把 tick 防抖写入的未来 nextRunAt 覆盖回过去。
 *  曾因 saveTask({...旧task}) 覆盖 → 下一 tick 立即再次触发 → 十几秒一跳疯狂循环。 */
describe("scheduler nextRunAt 防抖保留", () => {
  let db: Db;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hanalite-sched-"));
    db = new Db(dir);
    db.saveAgent(agent);
  });

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
    // 防抖后的 nextRunAt 是未来网格点(3h 网格 20:51 触发 → 21:00 属正常),绝不能再是"过去"
    expect(after.nextRunAt).toBeGreaterThan(Date.now());
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

/** 心跳避让主人:主人 30 分钟内说过话 → 本次心跳跳过(顺延下一网格点),不打扰正在聊天 */
describe("心跳避让主人", () => {
  it("主人刚说过话(10 分钟前)→ 心跳跳过,lastStatus=skipped,nextRunAt 顺延", async () => {
    const db2 = new Db(mkdtempSync(join(tmpdir(), "hanalite-yield-")));
    db2.saveAgent(agent);
    const task = makeHeartbeatTask();
    db2.saveTask(task);
    let ran = false;
    const engine = {
      runChat: async () => {
        ran = true;
      },
    } as never;
    const sched = new Scheduler(db2, engine as never, () => agent, undefined, mkdtempSync(join(tmpdir(), "hanalite-ws-")), () => Date.now() - 10 * 60_000);
    await sched.tick();
    const after = db2.getTask("t_hb")!;
    expect(ran).toBe(false); // 心跳没有执行
    expect(after.lastStatus).toBe("skipped");
    expect(after.nextRunAt).toBeGreaterThan(Date.now()); // 顺延到未来网格点
  });
});

/** 并发限流:同时最多 2 个任务在跑,多余的排队等下一 tick */
describe("任务并发限流", () => {
  it("已有 2 个任务在跑 → 第 3 个到期任务不启动", async () => {
    const db2 = new Db(mkdtempSync(join(tmpdir(), "hanalite-limit-")));
    db2.saveAgent(agent);
    const t1 = makeHeartbeatTask({ id: "t1", schedule: "0 0 * * *" });
    const t2 = makeHeartbeatTask({ id: "t2", schedule: "0 0 * * *" });
    const t3 = makeHeartbeatTask({ id: "t3", schedule: "0 0 * * *" });
    db2.saveTask(t1); db2.saveTask(t2); db2.saveTask(t3);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const engine = {
      runChat: async () => {
        await gate; // 挂起,模拟长时间执行,保持 running
      },
    } as never;
    const sched = new Scheduler(db2, engine as never, () => agent, undefined, mkdtempSync(join(tmpdir(), "hanalite-ws-")));
    await sched.tick(); // 启动 t1,t2(running=2)
    const before3 = db2.getTask("t3")!.nextRunAt;
    await sched.tick(); // 限流:running=2,t3 不启动
    expect(db2.getTask("t3")!.nextRunAt).toBe(before3); // t3 未被防抖推进(说明没启动)
    release();
    await new Promise((r) => setTimeout(r, 20)); // 等 t1/t2 的 runTask 结束、running 清空
    await sched.tick(); // t1/t2 完成后,t3 可启动
    await new Promise((r) => setTimeout(r, 10));
    // t3 已启动:nextRunAt 被防抖推进到未来网格点(runTask 的 mock 此刻已 resolve,状态可能已是 ok)
    expect(db2.getTask("t3")!.nextRunAt).not.toBe(before3);
    expect(["running", "ok"]).toContain(db2.getTask("t3")!.lastStatus);
  });
});

/** 避让上限:连续避让 2 次后强制执行(主人聊得再久,人格也得保持生活节奏,最长空档 = 间隔×2) */
describe("心跳避让上限", () => {
  it("已避让 2 次(skippedCount=2)→ 即使主人刚说过话也强制执行", async () => {
    const db3 = new Db(mkdtempSync(join(tmpdir(), "hanalite-limit2-")));
    db3.saveAgent(agent);
    const task = makeHeartbeatTask({ skippedCount: 2 });
    db3.saveTask(task);
    let ran = false;
    const engine = {
      runChat: async () => {
        ran = true;
      },
    } as never;
    const sched = new Scheduler(db3, engine as never, () => agent, undefined, mkdtempSync(join(tmpdir(), "hanalite-ws-")), () => Date.now() - 5 * 60_000);
    await sched.tick();
    expect(ran).toBe(true); // 强制跳了
    expect(["running", "ok"]).toContain(db3.getTask("t_hb")!.lastStatus); // 执行中/已启动(可能已完成)
    expect(db3.getTask("t_hb")!.skippedCount).toBe(0); // 计数清零
  });

  it("避让一次后 skippedCount 递增(第 1 次避让 → 1)", async () => {
    const db3 = new Db(mkdtempSync(join(tmpdir(), "hanalite-limit3-")));
    db3.saveAgent(agent);
    const task = makeHeartbeatTask();
    db3.saveTask(task);
    const engine = { runChat: async () => {} } as never;
    const sched = new Scheduler(db3, engine as never, () => agent, undefined, mkdtempSync(join(tmpdir(), "hanalite-ws-")), () => Date.now() - 5 * 60_000);
    await sched.tick();
    const after = db3.getTask("t_hb")!;
    expect(after.lastStatus).toBe("skipped");
    expect(after.skippedCount).toBe(1); // 第 1 次避让
  });
});
