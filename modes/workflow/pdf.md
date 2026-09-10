# Mode: workflow/pdf - Explicit PDF Confirmation

This mode is intentionally separate from the main workflow. It only renders a PDF after the user has reviewed and confirmed the HTML CV.

## Preconditions

1. Automatically select the latest eligible workflow record. A job ID may be supplied internally, but users do not need to provide one.
2. Require `artifacts.finalHtml` to exist. Never render from `cv.generated.html` or an unconfirmed editable draft.
3. Run the fact validator against the final HTML.

## Command

Run:

```powershell
node workflow.mjs pdf
```

The PDF is written to `output/workflow/<job-id>/<岗位名称>.pdf`, using the detected role title with illegal filename characters replaced by `-` and without a `最终版` suffix. The workflow record is updated, and `output/workflow/index.html` is refreshed.

If no final HTML exists for the selected role, stop and tell the user to run `npm run workflow:serve`, open the editable CV, and click `保存最终版` first. Never silently choose another CV version.
