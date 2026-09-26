# Mode: workflow/word - Editable Word Confirmation

This mode creates an editable `.docx` only after the user has reviewed and confirmed the HTML resume.

## Preconditions

1. Select the latest eligible workflow record, unless a job ID is supplied internally.
2. Require `artifacts.finalHtml` to exist. Never generate Word from the generated HTML or an unconfirmed editable draft.
3. Keep the candidate's optional photo in `workflow-input/photos/`; the generator uses the first supported image by filename, if one exists.

## Command

Run:

```powershell
npm run workflow:word
```

The Word file is written to `output/workflow/<job-id>/<岗位名称>-最终版.docx`, using the detected role title with illegal filename characters replaced by `-`. The workflow record and `output/workflow/index.html` are refreshed with a Word link.

Use the selected role's current editable HTML as the source. If it is missing, tell the user to run `npm run workflow:serve` and open that role's editable CV. Do not require a separate HTML confirmation/finalization step, and never silently choose another CV version.

Word generation is local-only. Do not commit candidate personal information, JD attachments, or photos to the public repository.
