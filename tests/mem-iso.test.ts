import { describe, expect, it } from "vitest";
import { MemoryService } from "../server/memory/service";

describe("独立记忆空间", () => {
  it("全局与人格记忆完全隔离", async () => {
    const svc = new MemoryService(
      { mode: "local", hindsightBaseUrl: "", hindsightApiKey: "", hindsightBankId: "t", localEnabled: true, experienceCap: 2000 },
      "/tmp/hana-mem-iso-test",
    );
    await svc.retain("全局事实A", "fact");
    await svc.retain("野生人格的秘密", "fact", "agent_wild");
    await svc.retain("野生经历X", "experience", "agent_wild");

    // 全局只看到自己的
    const g = await svc.recall("全局", 10);
    expect(g.map((i) => i.content)).toEqual(["全局事实A"]);
    // 野生人格只看到自己的
    const w = await svc.recall("野生", 10, "agent_wild");
    expect(w.map((i) => i.content).sort()).toEqual(["野生人格的秘密", "野生经历X"]);
    // 野生人格看不到全局
    const wg = await svc.recall("全局", 10, "agent_wild");
    expect(wg).toEqual([]);
    // stats 独立
    expect(await svc.stats()).toEqual({ facts: 1, experiences: 0 });
    expect(await svc.stats("agent_wild")).toEqual({ facts: 1, experiences: 1 });
    // 清空独立记忆不影响全局
    svc.clear("agent_wild");
    expect(await svc.stats("agent_wild")).toEqual({ facts: 0, experiences: 0 });
    expect(await svc.stats()).toEqual({ facts: 1, experiences: 0 });
  });
});
