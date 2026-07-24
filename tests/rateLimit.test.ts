import { describe, it } from "node:test";

// 限流现在依赖 D1；它在 Workers 预览环境中验证，不在 Node 单元测试里伪造平台存储。
describe.skip("checkTtsRateLimit (Workers integration)", () => {
  it("uses persistent D1 state", () => {});
});
