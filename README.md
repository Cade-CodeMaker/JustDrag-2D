# JustDrag-2D

把一张扁平的 AI 立绘，变成**可实时形变**的 WebGL 素材：若干部位（头、腿、胸……）各自轻微摇摆，运行时零开销，交付物是一个可双击打开的自包含 HTML。

原理、选型理由和边界写在 [DESIGN.md](DESIGN.md)。本文件只讲**怎么用**。

---

## 环境

整个项目跑在**一个** conda 环境里 —— Python 管线和前端工具链都在其中。不需要第二个环境，
也不用管系统上装的是哪个 Node：

```bash
conda env create -f environment.yml   # 首次，在仓库根运行
conda activate justdrag
```

定义在 [environment.yml](environment.yml)：Python 3.13 + Node 26 + 全部 Python 依赖。
激活之后，同一个终端里 `python -m tools.cutout` 和 `npm run dev` 都能直接跑，
不必在两套工具链之间切换。

**准则：这个仓库只认 `justdrag` 一个环境。** 不要再建第二个环境，也不要依赖系统 Node ——
两边版本一旦分叉，"在我机器上是好的"就会变成常态。要加依赖就改 `environment.yml`，
并同步 `requirements.txt`（`pip freeze` 出来的完整钉死清单）。

> 历史环境 `art` 已被 `justdrag` 取代，里面没有 Node。仓库里不应再出现 `art` 的路径。

---

## 快速开始

```bash
conda activate justdrag

python -m tools.cutout    sample              # 抠图 + 边缘扩散 + 生成起始 regions.json
python -m tools.build_demo sample             # → assets/sample/out/demo.html
python -m tools.preview   sample              # → anim_sheet.png / anim_weights.png
```

打开 `assets/sample/out/demo.html`，在画面上拖动枢轴调整位置，右侧面板调参数、导出。

**交付物里能做什么**

| 操作 | 说明 |
|---|---|
| 拖动枢轴十字 | 移动该部位的旋转中心。每帧从 uniform 读，**不重烘权重场**，所以拖动很轻 |
| 悬停 / 选中枢轴 | 显示它属于哪个部位 |
| `部位` 分组里的滑块 | **批量赋值** —— 拖一下就把该部位所有椭圆设成同一个数值 |
| 播放 / 缩放 / 背景 | 预览控制 |

椭圆的增删改、逐轴半径、旋转角度、部位增删这些**编辑能力在 `app/`**（见 [app/README.md](app/README.md)），不在交付物里：交付物的价值就是那个双击即开的零依赖单文件，往里塞编辑器是反方向。

> 画在椭圆上的那条**短线是朝向参考**：椭圆本身是对称的，转四分之一圈看起来一模一样，没有这条线就不知道 `旋转` 到底有没有生效。`rot = 0` 时它竖直向上。

> 把一个部位的椭圆**删光**是允许的（在 `app/` 里）：权重恒为 0，该部位保持静止，检视面板会写明而不会静默冻结。

脚本一律用 `python -m tools.xxx` 运行（`core/` `tools/` `verify/` 各有 `__init__.py`），仓库根自动进入 `sys.path`，依赖全部来自 `justdrag`，**不需要额外的 `pip install`、不需要打包器**。

`app/` 是浏览器端编辑器（见 [app/README.md](app/README.md)）：导入 → 抠图 → 调区域 → 导出 `demo.html` 全在网页里完成。它需要额外的 Node 依赖（Vite、onnxruntime-web），在 `app/` 下跑一次 `npm install` 即可 —— Node 本身也在 `justdrag` 里。浏览器需要 Chrome。

第 4 步还能导出一张**循环 GIF**（`gifenc`，只装在 `app/` 里，交付的 `demo.html` 仍然零依赖）。默认 512px / 10fps / 5 秒 / 开抖动，实测约 4.3 MB；256px 约 1.3 MB。取景固定为方形、**永远包含整张立绘** —— 预览里的「缩放」超过 100% 时方框会比窗口大，照那样裁出来就只剩角色中间一块，所以导出按 100% 取景并在状态行注明。

**循环接缝**靠自动挑起始相位压低，不改任何用户参数。它能压到多低取决于滞后怎么配：所有椭圆共享同一个滞后时是机器精度（`2e-9°`）；一旦给椭圆设了不同滞后（这正是「两条腿别齐步走」要的效果），每条曲线的零点就落到不同相位上，一个起始相位压不平全部 —— **此时状态行如实报出残差**（默认模板约 `1.2°`），而不是假装无缝。

---

## 目录布局

```
assets/                  ← 每张参考图一个文件夹，自包含（整棵子树 gitignored）
  sample/
    input.png            ← 【输入位置】参考图放这里
    regions.json         ← 该图的区域配置（枢轴 / 椭圆 / 可选 _params）
    out/                 ← 【产物位置】该图的全部产物（可随时重建）
  <再来一张图就再开一个文件夹>

core/                    ← 与渲染框架无关的共享定义
  paths.py               素材目录解析（唯一知道 assets/ 布局的地方）
  region_field.py        权重场：Python oracle
  region_field.js        权重场：浏览器/Node 真源（UMD-lite）
  deform.glsl            形变片元着色器（唯一真源）
  deform.py              位移场：Python oracle
  matting.py             rembg 抠图 + bleed()
  default_regions.json   新素材的起始椭圆模板

tools/                   ← 管线
  cutout.py      build_cutout.py 的后继
  preview.py     preview_anim.py 的后继：离线参考渲染器
  build_demo.py  模板 → 自包含单文件 HTML
  template.html  ★ 交付物的源码（枢轴拖动 / 批量滑块 / GL 接线 / 持久化 / 写盘 / 诊断）

app/                     ← 浏览器端编辑器：多部位、检视面板、GIF 导出、构建 demo.html
                          见 app/README.md

verify/                  ← 验证
  check_bleed.py  check_fringe.py   抠图质量的定量诊断
  test_weight_golden.js             跨语言权重场金标准
  test_bake.js                      无 GPU：逐部位不变量、单椭圆部位逐字节
  compare_equivalence.js            当前 demo vs 重构前 demo.baseline.html
  test_persist.js                   CDP 端到端，打交付物（35 项）
  dump_weights.py                   test_weight_golden.js 的 Python 端
```

> `app/src/stage.js` 与 `tools/template.html` 是**同一套 GL 接线的两份拷贝**，而没有任何运行时测试证明它们在渲染上一致。这是当前维护风险最高的一处：改 GL 时两边都要动。

### 什么该进 git

**`assets/` 整棵子树都不进 git**，只剩占位文件撑住上面的目录图（见 [assets/README.md](assets/README.md)）。

| 路径 | 状态 | 理由 |
|---|---|---|
| `assets/<name>/input.png` | 不进 git | 立绘版权不属于本项目，这里只是本地工作副本 |
| `assets/<name>/regions.json` | 不进 git | 眼睛调出来的，但只对本地这张图有意义 |
| `assets/<name>/out/` | 不进 git | 全部产物都能从上面两者重建 |

`input.png` 与 `regions.json` 在**语义上仍是权威输入** —— 管线只认它们，产物一律可丢弃。
它们只是没被提交而已，换台机器需要自己把这两样带过去。

> 例外是抠图产物 `character_*.png`。它由 rembg 推理生成，**跨版本不保证逐位可复现**；真正的权威是 `input.png`，必要时重跑 `tools.cutout` 即可，但边缘会有肉眼可见的细微差异。

---

## 加一张新参考图

```bash
python -m tools.cutout demo2 --src /path/to/new_art.png
```

`--src` 会把图复制到 `assets/demo2/input.png`，抠图，并在 `regions.json` 缺失时**自动生成一份起始配置**（`core/default_regions.json`，一个通用的站立人形：头部枢轴 `[0.5, 0.30]`、腿部 `[0.5, 0.62]`、胸部 `[0.5, 0.58]` 三个部位）。

起始配置**只是让你有东西可拖**，椭圆位置一定不准，必须打开 demo 手动调到贴合。

想把已经调好的配置复制到新素材：

```bash
python -m tools.cutout demo2 --src new.png --from sample
```

随后照常 `build_demo` / `preview`。

### 调好的配置怎么回到磁盘

demo 右侧面板底部有**「保存到 regions.json」**：

1. 第一次点，弹出文件框 —— **自己导航到 `assets/<名字>/regions.json` 并选中它**。页面是 `file://` 打开的，它无从知道仓库在哪，只能建议文件名。
2. 之后每次点都是**静默直接写入**，不再弹框。Chrome/Edge 会记住 `id` 对应的目录，所以重开浏览器后第一次也不用重新导航。
3. 写完状态行会提示「需重新运行 `tools.build_demo` 才会烘焙进 demo」—— **保存的是源文件，不是当前页面**。

它用的是 File System Access API（`showSaveFilePicker`）：句柄存在 IndexedDB 里（key 与 localStorage 同一个：`nova-art-deform-<name>-v1`，按素材区分），所以 `file://` 下也能持久化，不需要起本地服务器。Firefox/Safari 没有这个 API，按钮会自动退化成「导出到文本框 + 复制到剪贴板」，并在状态行说明原因。

面板里还有**「导出区域配置」**，随时可以拿到 JSON 手动粘贴，作为兜底。

与此同时，你的每一次拖动和滑块改动都会**自动存进 `localStorage`**，刷新不丢。这是「工作现场」的备份，和上面写回源文件是两件事 —— 刷新丢的是没写回磁盘的那部分。

> 保存时 `_comment` 之类的 `_` 前缀元数据会被原样保留：它们在构建时被烘焙进页面，否则第一次保存就会把你手写的注释冲掉。

可用命令一览：

| 命令 | 作用 |
|---|---|
| `python -m tools.cutout <name> [--src PATH] [--from NAME] [--model M]` | 抠图 + 边缘扩散 + 生成起始配置 |
| `python -m tools.preview <name> [--model M]` | 离线参考渲染 → `anim_sheet.png`、`anim_weights.png` |
| `python -m tools.build_demo <name> [--model M]` | 模板 → `out/demo.html` |

`--model` 只在同一素材存在多个抠图变体时才需要（`out/character_*.png` 多于一个时，不指定会直接报错而不是猜）。

---

## 验证

```bash
conda activate justdrag

# ① 跨语言权重场：core/region_field.py 与 core/region_field.js 数值等价
node verify/test_weight_golden.js sample        # 默认用 justdrag 的 python；PY=... 可覆盖

# ② 无 GPU 的权重场不变量：每部位通道和 ≤ 覆盖，单椭圆部位逐字节相同
node verify/test_bake.js sample

# ③ 渲染逐像素：当前 demo vs 重构前的 demo.baseline.html
node verify/compare_equivalence.js sample       # 反向验证：--perturb / --inject 应当 FAIL

# ④ 端到端：真实鼠标输入 → 拖枢轴 → 批量滑块 → 保存 → 刷新恢复（35 项）
node verify/test_persist.js sample

# ⑤ 抠图质量诊断（输出 PNG 供肉眼复核）
python -m verify.check_bleed  sample [--crop x,y] [--half N]
python -m verify.check_fringe sample [--crop x,y] [--half N]

# ⑥ 浏览器端编辑器：动画数学 + GIF 编码（纯 Node，秒级，不需要浏览器和模型）
cd app && npm run test:pose && npm run test:gif

# ⑦ 浏览器端编辑器：界面流程 / 导出与 Python 逐字节一致 / 产物可开 / 刷新可恢复 / GIF
cd app && npm run test:ui
```

`--crop` 不指定时会**自动选最大位移像素**，所以换素材直接跑就行，不需要改脚本。

**为什么权重场要实现两遍**：`core/region_field.js` 是浏览器实际运行的；`core/region_field.py` 是离线 oracle，`tools/preview.py` 和 `verify/` 的诊断都建在它上面。两者互不生成，所以 `test_weight_golden.js` 是唯一阻止它们悄悄分叉的东西 —— 也正是它让 Python 渲染器有资格作为 shader 的参考。

同理，`core/deform.glsl` 与 `core/deform.py` 保持逐行等价；`verify/check_fringe.py` 的 `bleed_from()` 刻意**不**复用 `core/matting.bleed()`，否则就是拿自己证明自己。

---

## 已知问题

- **边缘轻微色晕**：`core/matting.bleed()` 以 `alpha > 0` 为种子扩散颜色，而 rembg 在角色轮廓外留了一圈约 2px 的近黑、微透明像素。它们被当作「已知颜色」，于是黑被扩散进了边缘。`verify/check_fringe.py` 就是量化这个现象的。**当前行为是刻意保留的** —— 改它会改变已发货的抠图。见 DESIGN.md §7。
- **幅度上限**：实用区间约 ±2~8°。再大就会暴露单层图的物理限制（无法改变遮挡关系）。
- **区域形状靠手调**：目前是椭圆并集，复杂角色需要手绘掩码或更好的分割。
- **保存位置要自己选**：页面无从知道仓库路径，第一次保存必须自己导航到 `assets/<名字>/regions.json`。选错文件不会有任何提示 —— 它只会老实写进你选的那个文件。
- **检视面板显示 4 位小数**：约合 1024px 图上 0.1px，比权重图本身的 1/256 分辨率还细，够用。模型里仍是全精度，且只回写你正在编辑的那一个字段，所以改旋转不会把中心一起四舍五入掉；保存到磁盘的值也不做任何舍入。
- **每椭圆一条通道有量化缺口**：一个部位的通道之和最多比它的覆盖少 `n_r − 1` 个 LSB（`n_r` = 该部位的椭圆数）。单椭圆部位是逐位精确的；正常配置（每部位 2~4 个椭圆）下偏差是亚像素的。容差由椭圆数推出，不写死。
- **椭圆数量有上限，而且是两个**。项目自身的硬上限是 **28**（7 张 RGBA 权重纹理 + 角色图 = 8 个纹理单元，WebGL1 的保证值）。但设备侧还有一个更早到顶的：`MAX_FRAGMENT_UNIFORM_VECTORS` 规范只保证 16，每个椭圆占 2 个 vec4，扣掉固定的 8 个之后**只剩 4 个椭圆** —— 比纹理侧少七倍。所以上限是运行时查询、两者取小；不够时诊断面板会写明原因和实际数字，不会黑屏。
- **两份 GL 接线**：`app/src/stage.js` 和 `tools/template.html` 各有一份，没有运行时测试证明它们一致。
