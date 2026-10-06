# assets/sample/ —— 占位目录

README.md 目录图里的那个示例素材夹。**这里面的文件都不进 git**，本文件只是占位。

要跑通快速开始，需要在这里放两个东西：

| 文件 | 怎么来 |
|---|---|
| `input.png` | 参考立绘。放进来，或用 `python -m tools.cutout sample --src <图>` 复制进来 |
| `regions.json` | 首次跑 `tools.cutout` 会自动生成一份起始配置；之后在 demo 里手调到贴合，点「保存到 regions.json」写回 |

`out/` 是产物目录，由管线自己创建，不需要手动建。

```bash
conda activate justdrag
python -m tools.cutout    sample
python -m tools.build_demo sample     # → out/demo.html
python -m tools.preview   sample      # → out/anim_sheet.png, out/anim_weights.png
```

> `regions.json` 缺失时 `tools.cutout` 才会生成起始配置；**它不会覆盖已存在的文件**，
> 所以手工调好的那份是安全的。
