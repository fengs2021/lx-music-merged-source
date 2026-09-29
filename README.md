# 聚合音源·净化版

洛雪音乐（LX Music）整合音源。基于 [pdone/lx-music-source](https://github.com/pdone/lx-music-source) 全量 10 个音源的逐一实测结果，以其中唯一存活且可读的 qdy 9.3 聚合源为骨架精炼而成。

## 检验结论（2026-09 实测）

| 原音源 | 状态 | 说明 |
|---|---|---|
| qdy 全豆要聚合 9.3 | ✅ 部分可用 | wy/kw 通过；本仓库整合脚本的骨架 |
| changqing 长青 svip | ❌ | 中转 yinyue.haitangw.net 无响应 |
| huibq | ❌ | lxmusicapi.onrender.com 已 Service Suspended |
| ikun | ❌ | api.ikunshare.com 无响应 |
| sixyin 六音 | ❌ | 全平台超时/无直链 |
| huanyin 幻音 | ❌ | 全平台 network 错误 |
| lx 独家 | ❌ | 全平台 dispatch 失败 |
| flower 野花 | ❌ | 全平台 dispatch 失败 |
| grass 野草 | ❌ | dispatch 失败 |
| juhe 聚合api-cf | ❌ | 沙箱加载即失败 |

## 整合版链路

- **星海主 API**（music-api.gdstudio.xyz）：wy/tx/kw/kg/mg 五平台直链，带熔断（连续 3 次失败冷却 10 分钟）
- **溯音 oiapi.net** 兜底：
  - wy → Music_163 直链
  - tx → QQ_Music 码率阶梯回退
  - kw → Kuwo 关键词搜索（严格歌名匹配）
  - mg → 咪咕搜索（间歇可用）
- URL 缓存 6 小时（容量 500），多链并发最快者胜
- 已剪除原版全部死亡链路：长青/念心（haitangw/nxinxz）、聆川（占位假地址）、onrender、汽水 VIP

## 导入方式

洛雪音乐桌面版 → 音源设置 → 自定义源 → 导入：

```
https://ghproxy.net/https://raw.githubusercontent.com/fengs2021/lx-music-merged-source/main/merged-source.js
```

直连备用（可自行替换其它加速前缀，如 `gh-proxy.com/`、`mirror.ghproxy.com/`）：

```
https://raw.githubusercontent.com/fengs2021/lx-music-merged-source/main/merged-source.js
```

## 免责声明

仅供学习研究，音源接口来自公开网络，稳定性取决于上游，随时可能失效。
