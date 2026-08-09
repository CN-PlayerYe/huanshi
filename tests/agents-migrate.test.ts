import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDefaultAgents } from "../server/agents";
import { Db } from "../server/storage";

describe("内置人格模板迁移(小和/效率君/文心 → 小盏/小尺/小墨)", () => {
  it("旧名内置人格被同步为新模板,用户自定义名字后不再覆盖", () => {
    const dir = mkdtempSync(join(tmpdir(), "hanalite-agents-"));
    const db = Db.fromPaths({ dataDir: dir } as never);
    // 模拟旧版本数据:内置 id 但旧名字
    db.saveAgent({
      id: "gentle",
      name: "小和",
      description: "旧描述",
      systemPrompt: "旧模板内容",
      memoryEnabled: true,
      tools: [],
      createdAt: 1,
    });
    db.saveAgent({
      id: "writer",
      name: "我的专属文心", // 用户已自定义名字 → 不应被覆盖
      description: "自定义",
      systemPrompt: "自定义提示词",
      memoryEnabled: true,
      tools: [],
      createdAt: 2,
    });

    const agents = ensureDefaultAgents(db);
    const gentle = agents.find((a) => a.id === "gentle")!;
    expect(gentle.name).toBe("小盏");
    expect(gentle.systemPrompt).toContain("温润茶灯");
    const writer = agents.find((a) => a.id === "writer")!;
    expect(writer.name).toBe("我的专属文心"); // 未被覆盖
    expect(writer.systemPrompt).toBe("自定义提示词");

    // 幂等:再跑一次不重复改动
    const again = ensureDefaultAgents(db).find((a) => a.id === "gentle")!;
    expect(again.name).toBe("小盏");
  });
});
