# assets/ —— 占位目录

**这个目录里的素材不进 git。** 整棵子树被 `.gitignore` 排除，只剩本文件和各素材夹里的
`README.md` / `out/.gitkeep` 撑住目录结构。

```
assets/
  <name>/
    input.png       ← 参考图放这里（不进 git）
    regions.json    ← 该图的区域配置，在 demo 里调到贴合后手动存回（不进 git）
    out/            ← 该图的全部产物，可随时重建（不进 git）
```

## 为什么

- **立绘版权不属于本项目**。`input.png` 是别人的画，放进来只是本地工作副本。
- **`regions.json` 是本地手调的结果**。控制点位置和 `_params` 靠肉眼对着图调出来，
  换台机器重建不出来 —— 但它同样只对本地这张图有意义。
- **`out/` 全是派生物**。`input.png` + `regions.json` 就能重跑出来。

## 重建一份素材

```bash
conda activate justdrag
python -m tools.cutout   <name> --src /path/to/art.png   # 抠图 + 生成起始 regions.json
python -m tools.build_demo <name>                        # → out/demo.html
```

`<name>` 就是这里新建的文件夹名。起始配置一定不准，必须打开 demo 手动调。

完整说明见仓库根的 [README.md](../README.md)。

## 新增素材夹

新开一个 `assets/<name>/` 即可，`.gitignore` 里的规则是 `assets/*/` 通配的，
不需要改任何东西 —— 除非你想让这个空壳夹出现在 git 里：那就在新夹里放一个
`README.md`，规则会自动放行它。
