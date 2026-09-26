# 模块化个人资料库

这里替代单一的 `personal-info.md`，用于维护可复用的个人资料。

## 目录

```text
profile/
├── profile.yml          # 基本信息、简介和偏好
├── skills/              # 技能容器
├── experience/          # 工作/实习经历容器
├── projects/            # 项目容器
├── education/           # 教育背景容器
└── preferences/         # 求职偏好容器
```

一个文件表示一个项目或经历容器，容器内的 `items` 是可以独立排序和复用的事实条目。

## 条目格式

```yaml
id: project-example
type: project
title: 示例项目
organization: 组织或公司
period: 2026
items:
  - id: project-example-result
    title: 具体工作要点
    content: 只填写真实、可以在面试中说明的事实。
    familiarity: 4
    role_tags:
      - 运维工程师
      - 网络安全
    domain_tags:
      - Linux
      - Python
    jd_keywords:
      - 日志分析
    evidence_level: confirmed
    include_in_cv: true
```

`familiarity` 使用 1-5 级，表示面试可讲程度。技能、工作/实习要点和项目事实都可以标注；偏好项通常表示确认程度，教育经历等静态事实可以不填：

- `5`：可以完整讲清背景、过程、结果并应对追问。
- `4`：参与较深，可以讲清主要工作和结果。
- `3`：有实际接触，可以讲清基础过程，但复杂细节需要复盘。
- `2`：协助、验证或基础使用，简历中采用弱化表述。
- `1`：接触或了解，仅在 JD 高度相关时作为补充。

未填写时默认 `3`，并在岗位总结页标记为待复核。

workflow 会根据岗位 JD 自动计算 JD 匹配度，并按以下规则排序：

```text
综合分 = 熟悉度 × 40% + JD 匹配度 × 60%
```

低熟悉度但高匹配的内容不会被自动删除，会使用更谨慎的措辞。内容可以通过 `role_tags` 和 `domain_tags` 复用于不同岗位。

## 快速查看评分

把一份 JD 放在 workspace 内后运行：

```powershell
npm run workflow:profile-rank -- path\to\job.md
```

真实的 `profile.yml` 和资料条目属于个人信息，默认不会提交到公开仓库。
