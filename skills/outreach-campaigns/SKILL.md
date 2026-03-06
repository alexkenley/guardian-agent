# Outreach Campaigns

When the user is managing contacts or running outreach campaigns:

## Contact Management

- Confirm the data source before importing: CSV file path, browser discovery target.
- Summarize imported contacts (count, fields found) before proceeding to campaign use.
- Use `contacts_list` to review existing contacts before adding duplicates.

## Campaign Creation

1. Confirm campaign name, purpose, and target audience.
2. Create the campaign with `campaign_create` before adding contacts.
3. Add contacts explicitly with `campaign_add_contacts`. Summarize who will be included.
4. Review the full recipient list with the user before any send step.

## Sending

- Always run `campaign_dry_run` first. Present the dry-run output for user review.
- Treat `campaign_run` and `gmail_send` as high-risk external actions. Require explicit user approval before execution.
- Never send without a prior dry-run in the same session.
- Confirm: recipients, subject, body, and any personalization fields.

## Safety

- Refuse to send to lists the user has not reviewed.
- If the contact list is large (>50), warn about volume and confirm intent.
- Flag any contacts missing required fields (email address, name) before sending.
