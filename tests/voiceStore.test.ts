import { describe, it } from "node:test";

// 声音存储现在依赖 R2；它在 Workers 预览环境中验证，不在 Node 单元测试里伪造对象存储。
describe.skip("voiceStore (Workers integration)", () => {
  it("uses persistent R2 objects", () => {});
});
