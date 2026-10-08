UGPass automated lookup - first full-workflow trial

1. Copy ugpass-run.cjs and records.json into your existing ugpass-record-lookup folder (beside node_modules).
2. Connect your VPN.
3. In that folder's VS Code terminal, run: node .\ugpass-run.cjs --limit=5
4. Enter your username and password when prompted. Password typing is hidden and credentials are not saved to files.
5. Watch the first lookup. Login and navigation are automated. Date range is 1 October 2024 through the Kampala date when the run starts.
6. Review UGPASS-results.csv in Excel. It contains the original seven columns in the original order. Previous-account cells remain blank. Unprocessed rows stay blank; failed lookups say REVIEW in Comment.
7. Close the CSV in Excel before running again, so Windows does not lock the output file.

Only after comparing trial results manually, use: node .\ugpass-run.cjs --limit=2269
Runs skip completed rows, retry unresolved rows, and save after each attempt. Two consecutive errors stop the run. Interrupt with Ctrl+C. progress.json contains resumable results. Keep it private along with records.json and the CSV.

The included records.json is a read-only extraction of the supplied 2,269 Excel rows. Later edits to the Excel file do not automatically update this extraction.
The original .xlsx is never overwritten. The output is CSV, which opens in Excel; use Save As to create an .xlsx if required. CSV does not retain the original workbook's formatting. Identifiers are copied as strings, but use Excel Data > From Text/CSV and select Text for identifier/contact columns if Excel changes their display.
Source strings beginning with a formula prefix are protected with an apostrophe in CSV.

No subscriber match, an unfamiliar status, network error, zero-results view without a visible count, or a date-picker reset is flagged for review rather than guessed. No account-history conclusions are inferred.
This build has passed JavaScript syntax checks, but its automated calendar and login steps require the local trial. It does not bypass VPN, security checks, or access permissions. No portal account settings are changed.
For a new run date, rename progress.json before starting to avoid mixing results from different date ranges. Preserve old progress and outputs as needed.
