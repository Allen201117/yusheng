# SiliconFlow CosyVoice 接入笔记

## 为什么选 CosyVoice

Slice 1 需要快速跑通"声音克隆"的端到端闭环。三种路径：

| 路径 | 工程量 | 限制 |
|---|---|---|
| 自部署 GPT-SoVITS | 高（需 GPU 机器、模型下载、Docker） | 音质最佳、无第三方依赖 |
| **SiliconFlow CosyVoice API** | 低（一个 HTTP 调用） | 需要联网、按量计费、声音上传到第三方 |
| 浏览器 SpeechSynthesis | 极低 | **不是克隆**，只是读字 |

Slice 1 选 CosyVoice，因为目标是**先让闭环跑起来**。等切片 4 之后再评估是否切回自部署 GPT-SoVITS。

## 关键 API

POST `https://api.siliconflow.cn/v1/audio/speech`

```json
{
  "model": "FunAudioLLM/CosyVoice2-0.5B",
  "input": "想让 AI 朗读的目标文本",
  "voice": "",
  "response_format": "mp3",
  "references": [
    {
      "audio": "data:audio/wav;base64,UklGRi...",
      "text": "参考音频的文字稿"
    }
  ]
}
```

返回：`audio/mpeg` 二进制流。

## 注意事项

1. **参考音频文字稿必须准确**。CosyVoice 用这段文字和音频做对齐，错字会让克隆效果显著下降。
2. **参考音频时长 10-30 秒**最合适。太短捕捉不到音色特征，太长会让请求 base64 体积膨胀（30 秒 16kHz 单声道 wav ≈ 1MB，base64 后 ≈ 1.4MB）。
3. **输入文字 ≤ 500 字**。Slice 1 在 `/api/tts` 强制了上限。
4. **方言支持**。CosyVoice 对普通话、粤语、四川话、上海话都支持，对应方言的参考音频 + 同方言的目标文字即可。
5. **计费**。按字符数计费，详见 https://siliconflow.cn 定价页。

## 已知坑

- 第一次调用冷启动可能 5-10 秒，后续 1-3 秒。Slice 1 不做加载动画（黑底白字硬等），加载体验等 Slice 4 再处理。
- 参考音频如果是手机录的 m4a，建议在客户端先转 wav。Slice 1 我们让用户自己处理，不在服务端做 ffmpeg。

## 未来切换到自部署 GPT-SoVITS

只需：
1. 在内网起 GPT-SoVITS 容器，暴露 9880
2. 把 `src/lib/cosyvoice.ts` 换成 `src/lib/sovits.ts`，接口签名保持 `synthesizeWithClonedVoice(input)` 不变
3. `/api/tts/route.ts` 一行 import 切换

接口边界已经按这个目标设计好了。
