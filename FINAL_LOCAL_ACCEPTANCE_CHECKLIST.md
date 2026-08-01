# Final Local Acceptance Checklist

Run these checks from a fresh branch based on the latest remote `Sub_Master`.

## 1. Repository safety

- [ ] `git fetch origin` completed.
- [ ] New integration branch created from the latest `origin/Sub_Master`.
- [ ] No direct work performed on `Sub_Master`.
- [ ] Local `.env` exists but is not staged.
- [ ] `git status --short` reviewed before every commit.
- [ ] No `.env`, token, key, ZIP, cache, installer, or backup file is staged.

## 2. Configuration

Copy `.env.example` to `.env` only on the local machine and provide valid local values. Never commit the real `.env`.

Public email OTP requires valid local values for:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USERNAME`
- `SMTP_APP_PASSWORD`
- `SMTP_FROM_EMAIL`
- `SMTP_USE_TLS`

## 3. Build and start

```powershell
cd "E:\PATH\TO\YOUR\FRESH\INTEGRATION\CLONE"

docker compose build backend frontend
docker compose up -d
docker compose ps
```

Expected services:

- `db` healthy
- `storage` healthy
- `ai_engine` healthy or operational after its model is available
- `backend` healthy
- `frontend` running

Do not use `docker compose down -v`; that removes persisted data and models.

## 4. Health checks

```powershell
Invoke-RestMethod "http://localhost:8001/api/health"
Invoke-RestMethod "http://localhost:8001/api/ready"
Invoke-WebRequest "http://localhost:3000" -UseBasicParsing
Invoke-WebRequest "http://localhost:8001/api/docs" -UseBasicParsing
```

- [ ] Backend health succeeds.
- [ ] Database readiness succeeds.
- [ ] Frontend responds.
- [ ] Swagger documentation opens.

## 5. Source validators and tests

```powershell
docker compose exec backend python scripts/validate_public_user_module.py
docker compose exec backend python -m compileall -q app
```

Run the project backend tests in an environment with development-test dependencies installed:

```powershell
python -m pytest backend/tests -q
```

- [ ] Public validator passes.
- [ ] Python compilation passes.
- [ ] Backend tests pass, including point-cloud tests with `laspy` and `lazrs` installed.
- [ ] Frontend production build passes.

For a host-side frontend build:

```powershell
cd frontend
yarn install --frozen-lockfile
yarn build
cd ..
```

## 6. Existing officer regression

Test each role with an existing account:

- [ ] Admin login and dashboard
- [ ] Commissioner login, notifications, review, and acceptance
- [ ] AEE login, review, Good/Moderate/Bad actions, and return reason
- [ ] AE login, issue submission, before/after images, and resubmission
- [ ] MLA read-only visualization
- [ ] Architect workspace
- [ ] Analytics and approved dashboards
- [ ] Map loading, layer controls, attributes, 3D and Street View components
- [ ] Dataset upload and drag-to-map redirect behavior
- [ ] Layer Review and unclassified-category assignment
- [ ] Existing activity/session history
- [ ] Existing officer notification read/unread behavior
- [ ] Existing remediation workflow colours, including Blue after AEE Good approval

## 7. Public-portal acceptance

- [ ] Welcome page exposes Public Login and Create Public Account links.
- [ ] `/public/register` opens.
- [ ] OTP request sends to the entered email.
- [ ] Invalid/expired OTP is rejected.
- [ ] Valid OTP completes registration.
- [ ] Username availability validation works.
- [ ] `/public/login` works independently of officer login.
- [ ] Refresh and logout work.
- [ ] `/public/dashboard` requires public authentication.
- [ ] `/public/map` loads and category colours/legend are correct.
- [ ] `/public/datasets` lists and uploads supported data.
- [ ] Public dataset bounds/layers/features load.
- [ ] Complaint submission records coordinates.
- [ ] Complaint image and geotag metadata are preserved.
- [ ] Public complaint status and notifications update.
- [ ] AE/AEE/Commissioner receive the intended officer notification.
- [ ] Officer complaint detail and image open correctly.
- [ ] Public data does not leak into unrelated officer analytics or approval logic.

## 8. Security and staged-content review

```powershell
git status --short
git diff --check
git diff --cached --check

git diff --cached --name-only |
  Select-String "(^|/)(\.env|scratch_pw)(/|$)|\.tok$|\.pem$|\.key$|\.p12$|\.pfx$|node_modules|dist|__pycache__|_installer|backup"

git grep --cached -n -I -E "BEGIN[[:space:]].*PRIVATE KEY" -- .
git grep --cached -n -I "SMTP_APP_PASSWORD" -- .
```

- [ ] No private file is staged.
- [ ] No real SMTP App Password is staged.
- [ ] Only safe placeholders appear in `.env.example` or documentation.
- [ ] No conflict markers remain.
- [ ] Full staged diff reviewed by a second person.

## 9. Commit and push only the integration branch

```powershell
git add -A
git diff --cached --stat
git diff --cached --name-status
git commit -m "feat(public): integrate citizen portal with latest Sub_Master"
git push -u origin integration/public-portal-all-features-20260729
```

- [ ] Pull Request targets `Sub_Master`.
- [ ] Build/test evidence attached to the Pull Request.
- [ ] No direct merge until review and acceptance are complete.
