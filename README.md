# Zotero DataCheck

[![zotero target version](https://img.shields.io/badge/Zotero-7--9-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero DataCheck 是一个运行在 Zotero 内部的表格数值筛查插件。它的目标是标记论文表格中值得进一步人工复核的异常模式，帮助读者更快完成初步检查。

## 项目信息

- 支持的 Zotero 版本：当前 release 兼容 Zotero 7 到 9 系列
- 发布形态：单个 xpi 安装包，可直接在 Zotero 中安装使用
- 构建基础：本项目基于 [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) 搭建

## 适用场景

- 在 Zotero 阅读论文时，快速筛查表格中的可疑数值模式
- 为审稿、复核、文献阅读和方法学习提供一个低门槛的辅助工具
- 在不离开 Zotero 的前提下，对选中的表格文本生成一份检查报告

## 你可以用它做什么

- 对 PDF 阅读器中选中的表格文本做本地分析
- 标记重复行、重复数值序列、重复数值列、异常百分比、异常 p 值和高重复值列
- 在样本条件满足时给出本福特偏离提示
- 输出带摘要、检测项、发现明细和重建诊断的报告

## 安装

1. 打开 GitHub Releases 页面并下载最新的 xpi 安装包。
2. 在 Zotero 中打开 工具 -> 插件。
3. 点击右上角齿轮按钮，选择 Install Add-on From File...。
4. 选择下载好的 xpi 文件并完成安装。

## 使用方法

1. 在 Zotero 中打开论文 PDF。
2. 在 PDF 阅读器里选中需要检查的表格文本。
3. 在选区弹窗中点击 DataCheck 分析命令。
4. 等待插件完成表格重建和检测。
5. 在报告窗口中查看摘要、命中项和重建诊断，再回到原文做人工复核。

## 当前支持的检测项

- 重复行
- 重复数值序列
- 主导重复值
- 越界百分比
- 越界 p 值
- 本福特偏离提示
  - 首位/次位/末位
- 舍入堆积
- p值阈值聚集
- 低离散数值列

## 结果如何解读

- DataCheck 输出的是风险信号，不是对论文或作者的结论性判断。
- 报告中的命中项只表示“值得继续检查”，不等于数据一定存在问题。
- 如果报告里同时出现重建诊断，优先先确认选区和表格重建是否准确。
- 对样本量要求较高的检测项，插件会在不适用时明确提示原因。

## 反馈与文档

- 如果你遇到误报、漏报、无法重建表格或界面问题，欢迎提交 issue。
