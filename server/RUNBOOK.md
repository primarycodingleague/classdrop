# ClassDrop hosted service: incident, backup and operations runbook

Internal. This is the procedure behind the promises in the data processing agreement
(Annex B) and the privacy notice. Keep it honest: if a step here is not done, change the
promise, not the step.

## Who

| Role | Who | Backup |
| --- | --- | --- |
| Service owner and incident lead | Charlie, hello@classdrop.co.uk | _(name a second person before launch)_ |
| Azure subscription owner | Charlie (Founders Hub subscription, MFA on) | — |
| Data protection contact | hello@classdrop.co.uk | — |

Production access is Charlie's Azure account only. No shared credentials. Add anyone
else as a named Azure user with MFA, never by sharing a password. Review who has access
each term; remove leavers the same day.

## 1. Personal data breach procedure

A breach is any accidental or unlawful destruction, loss, alteration, unauthorised
disclosure of, or access to, school data. A lost laptop with a signed-in staff session,
a bug that showed one school another's records, a compromised staff password, a
successful attack on the server, or a backup left somewhere public all count. A failed
sign-in attempt does not.

**Clock:** the school has 72 hours from *its* awareness to notify the ICO. Our promise is
to tell the school within **24 hours of our awareness**, so their clock starts with most
of its time left.

1. **Detect and record (hour 0).** Note the time you became aware, how, and what you know.
   Start a timeline in a private document; every action below gets a timestamped line.
2. **Contain (first hour).** Stop it getting worse before working out what happened:
   - compromised staff account → `DELETE /staff/:id/mfa` is not enough; reset the
     password in the database, delete the account's sessions, and tell the school office
     to re-issue sign-in details;
   - suspected server compromise → in Azure, stop the App Service, rotate the database
     password (`az postgres flexible-server update --admin-password`) and the storage
     account keys (`az storage account keys renew`), update the app settings, then start
     it again only when you understand what happened;
   - a bug leaking data between schools or roles → deploy the fix or, if that is hours
     away, stop the App Service. A school without sync for an afternoon is better than a
     leak continuing;
   - leaked backup or export → get it removed, record where it was and for how long.
3. **Assess (hours 1 to 12).** Which schools, which records, how many children, what kind
   of data (safeguarding records make it high risk automatically), who could have seen it,
   for how long. Use `access_log`, the App Service logs and Azure activity log. Be
   conservative: if you cannot rule a school out, it is in.
4. **Notify each affected school (within 24 hours).** Email the school's named contact,
   and telephone the office if the data is sensitive or the school is closed. Use the
   template below. Say what you know, say what you do not know yet, and say when the
   next update will come. Do not speculate about causes.
5. **Support the school's ICO decision.** The school decides whether to notify the ICO and
   data subjects; give them everything they ask for. If website or correspondence data we
   control is involved, *we* notify the ICO within 72 hours ourselves at ico.org.uk.
6. **Remediate and review (within two weeks).** Fix the root cause, add a test that would
   have caught it, and write a one-page post-incident review: what happened, timeline,
   impact, what changed. Send the review to affected schools. Keep it for six years.

### Notification template

> Subject: ClassDrop: personal data incident affecting [School]
>
> We are writing within 24 hours of becoming aware of a personal data incident that
> affects data your school holds in ClassDrop. This is our first notice and we will
> update you as we learn more.
>
> What happened: [one or two plain sentences].
> When: we became aware at [time, date]. We believe it began at [time, date].
> What data: [types of record], for approximately [N] pupils / [N] staff.
> Who may have had access: [who, or "not yet known"].
> What we have done: [containment steps].
> What we will do next: [remediation], with an update to you by [time, date].
> What you may wish to do: [advice, for example re-issuing parent codes].
>
> Your school is the data controller and decides whether to notify the ICO and the
> people affected. We will give you whatever you need for that decision. Contact:
> Charlie, hello@classdrop.co.uk, [phone].

## 2. Backups and restore

**What exists**

- Database: Azure Database for PostgreSQL Flexible Server, automated backups with
  point-in-time restore, 35-day retention (set by `deploy/azure.sh`).
- Media: Azure Blob Storage, locally redundant, with blob soft delete and versioning at
  35 days (set by `deploy/azure.sh`). A deleted or overwritten object can be undeleted
  within that window.
- Every school can also take its own full export from the app at any time (School →
  Export everything), and each device holds a working copy.

**Restore the database to a point in time**

```
az postgres flexible-server restore -g classdrop --name classdrop-pg-restored \
  --source-server classdrop-pg --restore-time "2026-09-16T07:00:00Z"
```

Then point the app at it (`az webapp config appsettings set ... DATABASE_URL=...`) or
copy the needed rows back into the live server with `pg_dump`/`psql`. Restoring a single
school's data: dump only `where school_id = '<id>'` from the restored copy and apply.

**Undelete a media object**

```
az storage blob undelete --account-name <sa> -c media -n "<schoolId>/<sha256>"
```

**Test it.** Once a term, restore the database to a scratch server, run the server's
test suite against it (`DATABASE_URL=... npm test`), and delete the scratch server.
Record the date and result at the bottom of this file.

## 3. Routine operations

| When | What |
| --- | --- |
| Daily (automatic) | App Service health check on `/health`; six-hourly maintenance job (expired sessions, unreferenced media, old tombstones, old log entries) |
| Weekly | Glance at Azure cost and the App Service log for 500s |
| Monthly | `npm audit` in `server/`, apply updates, run `npm test`, redeploy with `deploy/azure.sh` |
| Termly | Restore test (above); review who has Azure access; review this runbook |
| Yearly | Rehearse the breach procedure with a tabletop scenario; renew Cyber Essentials; review retention settings |

**Deploying a change:** merge to `main`, then run `deploy/azure.sh` in Cloud Shell. It
redeploys from `main` and leaves the database and storage alone. Deploy outside school
hours unless it is a security fix.

**Rotating secrets:** database password and storage keys as in section 1, step 2. Staff
tokens are hashed and expire on their own; a staff member's sessions can be killed by
deleting their rows in `sessions`.

**Suspending a school** (non-payment, or at the school's request): there is no switch
yet; delete the school's sessions to sign everyone out and tell the office. Add a
`suspended` flag if this comes up more than once.

## 4. Restore test log

| Date | Restored to | Tests | Notes |
| --- | --- | --- | --- |
| _(none yet)_ | | | |
