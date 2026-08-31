# Krea 2 生图集成

「无限心动」用 **gemma-4-26b** 做提示词扩写，调用**独立容器**里的 **Krea 2 Turbo**（krea/Krea-2-Turbo）出图。

## 为什么这样连

Krea 2 是 Krea AI 从零训练的 flow-matching 文生图基础模型（8 步蒸馏，`guidance_scale=0.0`，无负提示词），输入就是**自然语言英文 prompt**，不需要 Ideogram 4 那套 JSON caption。我们用 gemma 把中文人设/场景描述扩写成英文 prompt，拼统一画风后缀后直接喂给 Krea 2。

关键决策：**提示词扩写放在无限后端（3000）侧做**，而不是让 Krea 2 容器去调 gemma。理由：

1. 后端和 gemma 同容器，`127.0.0.1:8000` 直连，零暴露。
2. 不把 gemma（vLLM 的 `/v1/chat/completions` 默认无鉴权）暴露到公网穿透——否则谁都能白嫖 26B 推理。
3. Krea 2 容器退化成纯生成器：收英文 prompt → 出图，完全不知道 gemma 存在。

```
无限后端(3000)
  └─ gemma 扩写(127.0.0.1:8000) ──→ 英文 prompt
  └─ HTTP 调 Krea 2 容器(穿透地址) ──→ PNG 字节
  └─ 存 image_blobs ──→ 返回文件名
```

## 拓扑

| 组件 | 位置 | 端口 | 说明 |
| :--- | :--- | :--- | :--- |
| gemma (vLLM) | 无限容器 | 8000 (127.0.0.1) | 扩写 + 游戏对话共用 |
| 后端 | 无限容器 | 3000 | 编排者 |
| vite 网关 | 无限容器 | 8080 | 穿透入口（/api → 3000） |
| Krea 2 服务 | **独立容器** | 8080 | 穿透出去，后端经公网地址调用 |

两个容器**无内网互通**，靠平台 8080 穿透地址互访。

## 一、Krea 2 容器部署

代码在 `/output/ideogram4-service/`（`server.py` + `start.sh` + `requirements.txt`）。目录名是历史遗留，实际服务的是 Krea 2。

1. 把这个目录拷到 Krea 2 容器。
2. 编辑 `start.sh` 顶部：
   - `IDEOGRAM_API_KEY` → 自定一个共享密钥（后端调用时用同一个）
   - 采样参数用默认即可：`KREA2_STEPS=8`、`KREA2_CFG=0.0`（Turbo 蒸馏版，禁用 CFG）
3. 运行 `bash start.sh`：装依赖（diffusers / transformers / modelscope 等，`--user`）→ 从 modelscope 下载 `krea/Krea-2-Turbo` 到 `<MODEL_DIR>/krea2-turbo-v2` → `uvicorn` 起 8080。
4. 把该容器的 8080 端口穿透出去，记下公网地址，例如 `https://xxx-krea2.example.com`。

验证（在任意能访问该地址的机器）：

```bash
curl -X POST https://xxx-krea2.example.com/generate \
  -H 'Content-Type: application/json' -H 'X-API-Key: ***' \
  -d '{"prompt":"a red cat sitting on a chair, masterpiece","width":1024,"height":1024}' \
  -o test.png
```

`GET /health` 返回 `{"status":"ok","krea2_loaded":true}` 即就绪。

## 二、无限后端配置

`.env`（或环境变量）加：

```bash
IDEOGRAM_URL=https://xxx-krea2.example.com
IDEOGRAM_API_KEY=<与 start.sh 一致的共享密钥>
IDEOGRAM_WIDTH=1024
IDEOGRAM_HEIGHT=1024
```

- 变量名沿用 `IDEOGRAM_*` 历史前缀（代码里是 `config.ideogramUrl` 等），**值指向 Krea 2 服务**。
- `IDEOGRAM_URL` 为空 → 生图功能整体关闭，接口返回「未配置」。
- 默认 1024×1024；头像建议 1024，朋友圈/聊天照片可用 `IDEOGRAM_WIDTH/HEIGHT` 或调用时传参降为 512/768。

## 三、验证链路

后端起来后（带 token）：

```bash
curl -X POST http://127.0.0.1:3000/api/ai-image/generate \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer ***' \
  -d '{"prompt":"一个红发少女站在樱花树下微笑，日系动漫风格","width":512,"height":512}'
```

返回 `{"imagePath":"<playerId>_<ts>_<uuid>.png"}`，然后用 `GET /api/uploads/<imagePath>` 查看图片。

## 四、三个用途的接线点

统一入口是 `lib/ai-image.ts` 的 `generateImage(playerId, prompt, opts)` → 返回文件名，各用途只负责触发 + 引用。用 `opts.scene` 区分两个分支：

| scene | 用途 | 转写规则 | 后缀 | 兜底 |
| :--- | :--- | :--- | :--- | :--- |
| `false`（默认） | 头像 / 立绘 | 中文 appearance → 英文外观，只写外观，`handsome young man` 锚定性别 | 半身像 + 精致脸 | gemma 失败用原始中文拼后缀（Qwen3-VL 能理解中文） |
| `true` | 朋友圈配图 / 背景图 / 聊天照片 | gemma 扮演摄影师：中文画面 → 英文 prompt，输出 `{prompt, has_person}` 自主判断是否出人；出人时用 `opts.appearance` 锚定外貌 + `opts.gender` 锚定称呼 | 基础后缀 + 出人时追加脸质量词 | gemma 失败用原始中文拼基础后缀 |

已接的触发点：

1. **头像**：`CreationCardPanel` / `CharacterEditModal` 调 `/api/ai-image/generate`（默认头像模式）或本地上传，写回 `character_data.avatar`。
2. **背景图**：`BackgroundPicker`（`scene: true`，appearance 留空，是否出人由 gemma 按玩家提示词判断）。
3. **朋友圈配图**：`moments.ts` `generateNpcMomentImage`（`scene: true` + `loadCharacterData` 取 appearance/gender）。
4. **聊天发照片**：`proactive.ts` `fillProactiveImage`（`scene: true` + 从 thread 反查 character 再 `loadCharacterData` 取 appearance/gender）。

## 已知边界

- **不接受图像输入**：Krea 2 是纯 text-to-image，无 img2img / 参考图 / init_image 参数。因此**无法保证同一人物跨图一致**（每次独立采样，脸/发型必漂）。
- **人物一致性限制**：因为无法保证一致性，配图里出现「角色本人」时脸仍可能和头像/主页角色漂移；但「禁止出人」的硬约束已放开——改由 gemma 按场景自主判断是否出人，出人时用角色 `appearance` 锚定外貌尽量贴近。头像用例不设（单次生成，不涉跨图）。
- **中文兜底**：Krea 2 文本编码器是 Qwen3-VL，能理解中文，所以两个分支在 gemma 扩写失败时都可直接原始中文拼后缀兜底（不再有「删脸硬约束」）。
- **鉴权**：Krea 2 服务穿透到公网，务必设 `IDEOGRAM_API_KEY`，否则任何人都能白嫖你的 4090。
- **并发**：Krea 2 服务内部用全局锁串行化生图（模型推理非线程安全），低频场景无感；高频请排队或加实例。

## 故障排查

### `ModuleNotFoundError: Could not import module 'Qwen3VLModel'`

- **原因**：Krea 2 文本编码器用 Qwen3-VL，其 `Qwen3VLModel` 依赖 `transformers.masking_utils`（5.x 才有）。若 transformers 下限太低装到 4.x 就报这个错。
- **解决**：`pip install --user transformers==5.9.0`（5.9.0 是甜点：太低缺 masking_utils，太高 5.10+ 又跟 torch 冲突报 `float8_e8m0fnu`）。

### `RuntimeError: operator torchvision::nms does not exist`

- **原因**：torchvision 和 torch 版本不匹配（或 CPU/CUDA 混装）。这条其实是 `Qwen3VLModel` 报错的**底层根因**——transformers 的 `image_utils` 顶部无条件 `import torchvision`，torchvision 炸了整条 import 链断，外层才包成 Qwen3VLModel 报错。两个错误是同一条链上的。
- **解决**：让 torchvision 匹配 torch（规律 torch 2.X → torchvision 0.(X+15)）：
  ```bash
  TV=$(python3 -c "import torch; v=torch.__version__.split('+')[0].split('.'); print(f'0.{int(v[1])+15}')")
  pip install --user "torchvision==$TV"
  ```
  若仍报错，说明非同源（CPU/CUDA 混装），成对重装：`pip install --user torch==<ver> torchvision==<ver> --index-url https://download.pytorch.org/whl/cu126`。
