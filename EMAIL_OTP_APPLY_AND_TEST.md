# Apply and Test — Email OTP Update

## 1. Configure local `.env`

Use a newly generated Google App Password. Do not reuse any password previously exposed in chat or screenshots.

```env
PUBLIC_OTP_DELIVERY=email
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=your-otp-account@example.com
SMTP_APP_PASSWORD=your_new_private_app_password
SMTP_FROM_EMAIL=your-otp-account@example.com
SMTP_FROM_NAME=Davanagere Smart Urban Survey
SMTP_USE_STARTTLS=true
SMTP_TIMEOUT_SECONDS=15
```

## 2. Build without `--no-cache`

```powershell
cd "E:\29_7_26_UPDATED\WebApp-Sub_Master"
docker compose build backend frontend
docker compose up -d --force-recreate backend frontend
```

## 3. Confirm health

```powershell
docker compose ps
docker compose logs --tail=150 backend
Invoke-WebRequest "http://localhost:8001/api/health" -UseBasicParsing
```

## 4. Public registration test

1. Open `http://localhost:3000/public/register`.
2. Confirm there is no registration location checkbox or Capture Location button.
3. Enter a new phone number and email address.
4. Confirm the OTP reaches the email Inbox or Spam folder.
5. Verify OTP, check username availability, and create the account.
6. Confirm the public dashboard opens.

## 5. Complaint test

1. Open Report a Problem.
2. Upload/capture an image.
3. Confirm the browser automatically requests complaint location permission; allow it and verify coordinates appear.
4. Submit the complaint.
5. Verify AE, AEE, and Commissioner notifications.
6. Open as Commissioner and verify the citizen receives one `Commissioner viewed your problem.` notification.

## 6. Officer regression

Test existing Admin, Architect, AE, AEE, Commissioner, and MLA login and their existing pages before approval.
