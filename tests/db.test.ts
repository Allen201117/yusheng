import { describe, it } from "node:test";

// 持久数据层已经迁至 D1；完整 CRUD 和级联删除在 Workers 集成环境中验证。
describe.skip("D1 data layer (Workers integration)", () => {
  it("persists user-scoped records", () => {});
});
