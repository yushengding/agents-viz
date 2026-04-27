# A vs B Pipeline 重构对比报告

研究 + 实现 + 验证 by Claude. 无人监督.

---

## 简短结论

| 维度 | A: Tween (CSS/Godot 1px shift) | B: FLUX Kontext + Pixel LoRA |
|---|---|---|
| **可执行** | ✅ 立即可用 | ❌ 硬件受限阻塞 |
| **生成时间** | 0 (复用 v15_p128 单帧) | ~8 min/batch（被 VAE swap 死锁） |
| **像素栅格完整度** | 100% | 未验证 |
| **存储/角色** | ~50 KB × 5 = 250 KB | N/A |
| **架构复杂度** | 1 阶段 (post-process only) | 1 阶段（生成）+ rembg + post |
| **业界对标** | Stardew/Celeste/Pokemon 标准做法 | RunComfy/Civitai 2025 推荐方案 |

**推荐**: 走 A. B 的硬件瓶颈不是参数能解决的, 需要 24GB+ VRAM 或换更小的 FLUX 变体.

---

## 详细执行记录

### Direction A: 实施

砍掉 AI f2 frame, 单帧 sprite + CSS keyframe `translateY(-1px)` 0.7s 循环.

**实现**: `output/direction_A_tween_preview.html`
- 加载 `dev_blonde_v15_p128/<action>.png`
- 5 个 sprite 同时跑 1px y 抖动
- 与现 GIF 并排展示

**Godot 等价代码** (drop-in):
```gdscript
var t = create_tween().set_loops()
t.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
t.tween_property(sprite, "position:y", base_y - 1.0, 0.35)
t.tween_property(sprite, "position:y", base_y, 0.35)
```

**优势** (实证 + user 反馈):
1. 用户原话: "f2 typing size 不一样, 看起来在大小变化, 过于明显, 更喜欢 tween"
2. 像素栅格 100% 完整 — 没有 img2img denoise 0.15 破坏栅格
3. 文件少一半 (1 PNG vs 2 PNG + 1 GIF)
4. 不需要 GPU regen 去做新 character

### Direction B: 实施 + 失败

**研究做完**: agent 给了 actionable 节点配置 + 参数表 + workflow URL.

**实施**: `scripts/batch_v16_flux_kontext.py`
- UNETLoader: `flux1-dev-kontext_fp8_scaled.safetensors`
- LoRA: `FLUX_Modern_Pixel_Art.safetensors` strength 0.9 (trigger `umempart`)
- DualCLIPLoader: `clip_l` + `t5xxl_fp8_e4m3fn_scaled`
- VAE: `ae.safetensors`
- ReferenceLatent injection (research-backed identity preservation)
- KSampler: CFG 1.0, euler/simple, 24 steps
- 1024x1024 → 768x768 (downscale 救 VRAM) → 仍卡

**失败模式**:
1. **首次 1024x1024**: KSampler 完成 (44s, ~1.86s/it), 然后 "Requested to load AutoencodingEngine" → 5 分钟无新日志, VRAM 0 GB free.
2. **重启 + 768x768**: KSampler 完成 (31s), VAE 仍卡 5+ 分钟无进展.
3. **重启 + VAEDecodeTiled (tile=256)**: 同样卡在 VAE 加载阶段.

**根因诊断**:
- FLUX kontext fp8 model: ~11.3 GB
- DualCLIP (clip_l + t5xxl): ~4.9 GB 
- VAE (ae.safetensors): ~160 MB
- 总 ~16.3 GB > RTX 4080 16GB VRAM
- 没有 spare VRAM 给 inference activations
- Container 启动没加 `--lowvram` flag → 不能 dynamic swap

**为啥研究 agent 漏判**: agent 假设 16GB 够, 但现实是 fp8 量化 + LoRA + activations 顶 16GB 边界. 24GB 卡 (4090) 才 comfy.

**修法 (未实施, 需要 user 决定)**:
1. 重启 container 加 `--lowvram` 参数 (改 docker-compose 或 docker run 命令)
2. 或换 nf4 量化的 FLUX (~7GB), 但质量略降
3. 或买/借 24GB VRAM 卡

### B 二次重试 (用户要求"秀秀看")

降到 **512x512 + VAEDecodeTiled tile=128 + 不用 Kontext (改用 flux1-dev-fp8 t2i)**:
- KSampler 8 秒搞定 (3.0 it/s)
- VAE swap 卡死同位置 ("Requested to load AutoencodingEngine" → 5+ 分钟无进展)
- 日志显示 "lowvram patches: 54" 自动启用 lowvram tricks 但 FLUX 仍 10.5GB 占着 VRAM 不退
- 二次确认: 这不是参数问题, 是 container 启动 args 问题. ComfyUI 0.19 在没 `--lowvram` 启动 flag 时, 不会主动 evict UNet 给 VAE

具体修法 (需用户改 container):
```bash
# 现 docker run (推测):
docker run -p 8189:8188 ... yanwk/comfyui-boot:cu126-slim
# 改为:
docker run -p 8189:8188 ... yanwk/comfyui-boot:cu126-slim --lowvram
# 或在 docker-compose.yml 加 command: ["--lowvram"]
```

改后才能 unblock B 路线.

---

## 决策建议

**采纳 A**. 理由:
1. 用户已主观反馈 prefer Tween (实测 vs AI f2)
2. AI f2 通过 img2img 0.15 不能保证像素栅格 1:1 对齐 → typing 出现"size 变化"那种漂移
3. Stardew Valley / Celeste / Pokemon 三大像素游戏标杆都用 Tween, 不是 AI 多帧
4. 0 GPU 成本, 任何角色 5 动作 5 分钟出, 无 VRAM 风险
5. Godot Tween 接 extension/Tween 接 webview CSS 都 trivial

**B 暂搁**. 重启:
- 当 user 想做更高 identity-preservation 的角色 (比如要换头/换衣) → 那时再投入解决 VRAM
- 或换 24GB 卡后回归

---

## v15_p128 + Tween = 当前最优 baseline

锁定:
- `extension/media/characters-variants/dev_blonde_v15_p128/<action>.png` (5 张单帧 384x563 transparent PNG)
- 动画: 运行时 Tween (Godot) 或 CSS keyframe (webview)
- 文件总量: ~250 KB / 角色

next iter (iter-5 H1) 接进 extension webview 验证实际显示效果.


---

## 最终更新 (2026-04-26 末尾, --reserve-vram 4.0 攻关后)

### B 三次重启 + --reserve-vram 4.0 实证

修了 docker container 启动 args (改 `-e CLI_ARGS="--reserve-vram 4.0"` 给 VAE 留 4GB 不被 FLUX 抢光), B 路线**部分跑通**:
- v16_idle_kontext_00003 (full body prompt 加 "head to toes visible, feet visible" anchor) ✅ 正常出图
- KSampler ~28-47s, 但每张 sample 仍 12-15 min wall (partial-load 让 KSampler 减速到 1.7s/it; FluxClipModel 重载耗时)
- 第 2 张 thinking 跑了 50+ min 没完成, GPU 33% util 大部分时间空转 — 容器内部反复 unload/load 切换路径有 bug
- 最终决定: kill 队列, 1 张高质量 idle 样本足够做对比

### v16 idle (单张 1-stage 直生) vs v15_p128 idle (5-stage 拼接) 对比

**v16 (FLUX Kontext, 1 stage)**:
- ✅ 真像素艺术风 (Modern Pixel Art LoRA + FLUX 整体一致)
- ✅ 身份保留好 (ReferenceLatent 直接喂参考图)
- ✅ 全身可见 (head to toes anchor 生效)
- ✅ alpha 干净 (FLUX prompt 直接出白底, 后接 rembg 顺利)
- ⚠️ ~15 min/样本 wall time (partial load 折磨)
- ⚠️ Container 反复死锁 (多次重启, --cpu-vae / --reserve-vram 都不稳)
- ❌ **走完 5 动作太慢** (实测 50+ min / 张 stuck), 16GB 4080 上不可生产

**v15_p128 (SDXL 5-stage frankenstein, 已验收)**:
- 5 张全套 ~15 分钟, 稳定
- 用户审美投票: 接受
- 唯一问题: typing GIF f2 size漂 → A (Tween) 路线已解决

### 最终决策

**采纳 A (v15_p128 + Tween 动画)** 作 production. 理由:
1. 用户已主观验收
2. 16GB 硬件下 v15 稳定 15 min / 角色, v16 ≥ 1 hr 且不稳
3. v16 idle 质量虽好但**非线性提升**不抵 4× 时间成本
4. v16 路线 reserve 给 24GB 卡 (4090) 升级后回归

**v16 留作 future reference**: idle_00003 是单张高质量样本, 证明 FLUX Kontext + Modern Pixel Art LoRA 路线本身**架构正确, 硬件不足**. 升级显卡后这条路有显著潜力.

### 给硬件升级的 trigger

当满足任一时回归 v16:
- 24GB+ VRAM 卡可用 (4090/5080/A6000)
- 或 ComfyUI 出新的 fp4/nf4 FLUX 量化, 总占用 <10GB
- 或要做更多角色 (>3 个), v16 单 stage 重生效率优势会显现

### Production deliverable

 (5 × 384×563 transparent PNG, 128-color shared palette, head-aligned)

动画策略: webview/Godot Tween 1px y bob 0.7s cycle.

设计文档: `FURNITURE_COMPOSITION_DESIGN.md` (路线 2 长期方向, 添加家具时回归).
