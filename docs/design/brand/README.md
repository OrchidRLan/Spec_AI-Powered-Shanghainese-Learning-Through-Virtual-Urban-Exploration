# 园亭对话 Logo

来源：[设计项目 Logo 候选](thread://01a14b79-7543-7372-a9a9-2313ecd3a88f?hostId=local)。用户选定第一款 A，并要求纯图标、上下组合、左右组合三个版本。本轮按 [批次 2 修改 1](../../Batch-2-revision-1.md) 接入。

## 资产

| 文件 | 用途 |
| --- | --- |
| [原纯图标](pavilion-mark-original.png) | 用户所选原始设计，保留带底色原图 |
| [原上下组合](pavilion-vertical-original.png) | 封面/介绍用储备资产，本轮未新建使用页面 |
| [原左右组合](pavilion-horizontal-original.png) | 用户所选横版原图 |
| [透明纯图标](../../../frontend/public/brand/pavilion-mark.png) | 手机页头与浏览器图标，1254 × 1254 PNG / alpha |
| [透明左右组合](../../../frontend/public/brand/pavilion-horizontal.png) | 桌面页头，1944 × 809 PNG / alpha |

2026-10-17 使用内置 imagegen，以对应原图为参考执行背景去除。未调用图像 CLI、未设置模型或尺寸参数。保留深青绿园亭对话轮廓、桥、水纹、树、赭红太阳及“沪语漫游 / A little Shanghai”文字。生成结果是栅格网页资产，不宣称与原图像素完全相同或为矢量母版。原图与透明图均保留，供后续设计调整核对。

## 本轮编辑提示

共同提示：

> Use case: background-extraction. Edit target: the provided approved logo. Prepare this exact artwork for a website. Remove ONLY the warm ivory background, including the background inside the symbol's openings, and all paper/background texture. Use genuine transparent alpha, no checkerboard painted into the image, no white/ivory matte, no shadow, no colored backdrop. Preserve crisp dark-jade artwork and the small terracotta accent, all shapes, lettering and identity; no redesign, no new elements.

纯图标追加：

> There is NO text in this symbol-only input. Preserve the exact pavilion speech-bubble outline, bridge, tree, water ripples, pillars and red sun. Do not simplify or redraw the mark. Output a square transparent image, with the actual emblem occupying 92% of the canvas width and proportional height, centered, with a small clear margin.

左右组合追加：

> Preserve exact horizontal lockup: the approved pavilion icon on the left, Chinese wordmark 沪语漫游 on the right with English A little Shanghai below it. Keep original lettering, precise characters and relative size/spacing. Remove excess outer canvas so the entire lockup nearly fills a wide horizontal transparent image with only a small consistent safety margin. Do not shift or rearrange the logo parts.

两个请求均设置 `transparent_background: true`。生产文件复制到仓库，应用不依赖个人生成缓存目录。
