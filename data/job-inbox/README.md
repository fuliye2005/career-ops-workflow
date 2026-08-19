# Career-Ops Workflow Inbox

把待处理岗位放在这个目录：

## URL

在 `jobs.txt` 中每行只写一个岗位 URL，不需要填写岗位 ID。workflow 会根据 URL 自动生成稳定的内部 ID，用户不需要记住或维护这个 ID：

```text
https://example.com/jobs/123
```

也兼容旧格式 `job-001 | https://example.com/jobs/456`，但新输入不需要填写 ID。

## Local JD Files

支持：

- PNG/JPG/WEBP/GIF 截图
- PDF
- DOCX
- TXT
- Markdown

当 `jobs.txt` 只有一个 URL 时，目录中的附件会自动归到这个岗位，即使附件文件名没有岗位 ID。多个 URL 时，如需关联本地附件，可以继续使用旧的 ID 前缀方式，例如：

```text
job-001-description.md
job-001-screenshot.png
job-001-recruiter.pdf
```

## Run

在仓库根目录执行：

```powershell
npm run workflow
```

它会先初始化并汇总输入。Codex 的 `career-ops workflow` 模式随后读取这些资料，完成 profile gate、岗位评估、简历建议和 HTML 产物。

PDF 不会在主 workflow 中自动生成。确认 HTML 简历后，直接运行下面的命令即可，系统会自动选择最近一个已确认的岗位：

```powershell
npm run workflow:pdf
```

编辑简历同样不需要填写岗位 ID：

```powershell
npm run workflow:prepare-editable
```
