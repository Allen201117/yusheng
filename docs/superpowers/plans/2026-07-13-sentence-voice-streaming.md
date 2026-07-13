# Sentence Voice Streaming Implementation Plan

**Goal:** Start synthesizing and playing the first complete reply sentence without waiting for the full answer, while applying bounded emotional delivery and preserving text fallback.

**Architecture:** The chat route converts the LLM token stream into ordered sentence events. A deterministic speech planner assigns supported emotion, intensity, speed and pause metadata. The browser starts TTS requests as sentence events arrive, prepares later sentences concurrently, and plays them in order. The TTS provider adapter converts only validated speech metadata into SiliconFlow's documented prompt and speed fields.

## Tasks

1. Add tested sentence segmentation, bounded emotion inference and provider instruction mapping.
2. Make the CosyVoice request use documented `stream`, `speed`, `gain` and `<|endofprompt|>` controls with timeout/error classification.
3. Emit ordered `sentence` SSE events from `/api/chat`, including the self-harm fallback.
4. Replace whole-reply playback with an abortable ordered sentence audio queue; retain manual whole-message replay.
5. Record first-sentence and TTS timing headers/log fields, run tests/typecheck/build, deploy Preview, and measure real first audio when cloud storage is available.

## Acceptance

- the first complete sentence starts TTS before the chat `done` event;
- later sentence requests may prepare concurrently but playback remains ordered;
- unsupported emotion input falls back to calm delivery;
- stopping a response aborts chat and outstanding TTS requests;
- text remains usable when any sentence TTS request fails;
- no visual redesign is introduced.
