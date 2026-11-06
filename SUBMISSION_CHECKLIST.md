# ReachInbox submission checklist

Complete the manual items before sharing the project. Checked items below were validated during the current preparation session; unchecked items have not been verified or performed.

## Repository and access

- [ ] Private GitHub repository created by the owner (no repository is created without approval).
- [ ] Backend and frontend committed.
- [ ] `.env`, `client/.env.local`, OAuth secrets, session secrets, Slack webhook URL/encryption key, private keys, and real lead data excluded from Git.
- [x] `.env.example` and `client/.env.example` contain placeholders only.
- [x] `.gitignore` covers local environment files, dependencies, builds, key files, and known local QA CSVs.
- [ ] Repository access granted to **Mitrajit** and **Yadav036**.

## Documentation and setup

- [x] Root README reviewed against current source and setup commands.
- [x] `DEMO_SCRIPT.md` prepared for a maximum five-minute recording.
- [ ] Checklist completed after remaining manual verification.
- [ ] Backend setup verified from a clean clone/environment.
- [ ] Frontend install and development server verified from a clean clone.
- [x] Frontend production build passes.
- [x] Docker Compose syntax validated.
- [x] Database migrations verified on the configured local database.

## Functional verification

- [ ] BullMQ worker restart persistence demonstrated without deleting Docker volumes.
- [ ] Scheduled email creation verified with synthetic/test recipients.
- [ ] Scheduled and Sent dashboard views verified.
- [ ] Sender hourly limit, minimum delay, and bounded concurrency demonstrated.
- [ ] Slack live notification verified if required by the submission.
- [ ] Demo video recorded, maximum five minutes.
- [ ] Demo video included in the repository or linked from the README.

## Automated validation

- [x] Backend typecheck and build pass.
- [x] Relevant backend automated tests pass.
- [ ] Final `git status` and staged-file list reviewed before commit/push.
- [ ] No real campaign recipients or production data included in screenshots/video.
