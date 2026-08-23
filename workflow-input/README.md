# 求职者输入区使用说明

本目录是 Career-Ops workflow 的公开模板输入区。请先把自己的资料放入对应位置，再运行 workflow。

## 目录结构

```text
workflow-input/
├── personal-info/
│   └── personal-info.md   # 公开仓库只保留简易占位内容；本地替换为真实信息
├── jd/
│   └── jobs.txt            # 每行填写一个岗位链接
└── photos/                # 可选：放一张求职者大头照，用于 Word 简历
```

`photos/` 不在 GitHub 中保存任何照片。Git 不会记录空文件夹，首次运行 workflow 时会自动创建它。

## 1. 填写个人信息

编辑 `personal-info/personal-info.md`，只填写真实、可核实、允许用于求职的内容，例如：

- 基本信息和联系方式
- 个人简介
- 核心技能
- 工作或实习经历
- 项目经历
- 教育背景
- 证书、语言和其他求职信息

不要把身份证、银行卡、密码、私钥或其他与求职无关的敏感信息放入仓库。真实个人资料文件默认不会被提交到公开 GitHub 仓库。

## 2. 填写岗位链接和 JD 附件

在 `jd/jobs.txt` 中每行填写一个岗位链接：

```text
https://example.com/jobs/123
https://example.com/jobs/456
```

除了链接，也可以把岗位 JD 的截图、PDF、TXT、MD 或 DOCX 文件直接放在 `jd/` 文件夹中，与 `jobs.txt` 并列。只有一个岗位链接时，目录中的附件会自动归到该岗位；多个岗位时，建议在附件文件名开头使用岗位 ID 或简短前缀，便于归类。

## 3. 添加照片

如需生成带照片的 Word/PDF 简历，把一张 PNG、JPG、JPEG、GIF 或 BMP 照片放入 `photos/`。workflow 会按文件名排序，使用第一张支持的图片；没有照片也可以生成 Word/PDF。

照片只用于本地生成，不要将真实照片提交到公开仓库。

## 4. 运行 workflow

在项目根目录执行：

```powershell
npm install
npm run workflow
```

确认岗位评分严格大于 `3.0/5` 后，启动本地页面编辑 HTML 简历：

```powershell
npm run workflow:serve
```

打开 `http://127.0.0.1:4173/`，进入“可编辑”简历，修改后点击“保存最终版”。

确认 HTML 最终版后，生成 Word：

```powershell
npm run workflow:word
```

Word 文件会写入 `output/workflow/<job-id>/`，文件名使用识别到的岗位名称，例如：

```text
运维开发工程师-最终版.docx
```

从 `npm run workflow:serve` 打开的可编辑页面点击“保存最终版”时，workflow 会自动保存最终版 HTML，并同时尝试生成 Word 和 PDF。PDF 文件名示例：

```text
运维开发工程师-最终版.pdf
```

如需单独重新生成 PDF，也可以显式执行：

```powershell
npm run workflow:pdf
```

带照片的 Word/PDF 会使用 `workflow-input/photos/` 中的照片；没有照片也可以生成。

## 5. 隐私提醒

以下内容默认属于本地个人数据，不应提交到公开仓库：

- `workflow-input/personal-info/` 中替换后的真实个人信息
- `workflow-input/jd/` 中的截图、照片、PDF、DOCX、MD 和 TXT 附件
- `workflow-input/photos/` 中的照片
- `data/workflow/`、`output/workflow/` 和根目录 `cv.md`

公开仓库只保留本说明、简易的 `personal-info.md` 占位文件和 `jobs.txt` 占位文件；真实个人信息、岗位链接和 JD 附件不要提交。`.gitignore` 会忽略个人信息和 JD 附件目录中的其他文件。
