# Public User Module — Email OTP and Registration Privacy Update

## Scope

This update changes only the isolated public/citizen module. The existing officer login, roles, cookies, dashboards, and AE → AEE → Commissioner workflows remain separate and unchanged.

- Officer login: `/login`
- Public login: `/public/login`
- Public registration: `/public/register`
- Public dashboard: `/public/dashboard`

## Final public registration flow

1. Citizen enters first name, last name, date of birth, contact phone number, and email address.
2. The backend creates a six-digit OTP challenge and sends the OTP to the email address through SMTP.
3. The citizen enters the email OTP, chooses an available username, and creates a password.
4. The backend stores the email as verified and creates a separate public session.

The phone number remains a contact number. Email OTP verifies the email address; it does not claim to verify ownership of the phone number.

## Registration location behavior

Registration no longer asks for GPS permission and no longer blocks desktop users when location is unavailable.

The server automatically records only request metadata available to the backend:

- registration date/time
- public IP address
- browser/user-agent
- reported screen size

A normal web backend cannot secretly obtain exact GPS coordinates or a MAC address. Exact location remains requested by the browser only when the citizen submits a geo-tagged complaint.

## Gmail SMTP configuration

Use a dedicated Gmail or Google Workspace mailbox with 2-Step Verification and a new Google App Password.

```env
APP_ENV=production
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
PUBLIC_OTP_TTL_MINUTES=5
PUBLIC_OTP_RESEND_SECONDS=60
PUBLIC_OTP_MAX_ATTEMPTS=5
```

The SMTP password is normalized by removing spaces before login. Never commit the real value to Git, frontend code, screenshots, documentation, or ZIP packages.

For local testing without sending email:

```env
APP_ENV=development
PUBLIC_OTP_DELIVERY=development
```

Development mode returns `debug_otp` only outside production. Production refuses development OTP mode.

## Database compatibility

Startup applies additive, idempotent changes:

- `public_users.email`
- `public_users.email_verified_at`
- nullable legacy `public_users.phone_verified_at`
- `public_otp_challenges.email`
- case-insensitive unique email index
- email challenge lookup index

Existing public users, complaints, sessions, officer users, notifications, PostGIS data, and MinIO objects are preserved.

## Complaint workflow

Complaint GPS behavior is unchanged:

1. Citizen uploads/captures an image.
2. Opening the report form automatically requests browser geolocation permission; the citizen can retry or refresh the fix when needed.
3. Complaint stores latitude, longitude, accuracy, optional landmark, image, IP, browser information, and time.
4. AE, AEE, and Commissioner receive notifications.
5. The first Commissioner view creates exactly one public notification: `Commissioner viewed your problem.`

## Build and run

From the project root:

```powershell
cd "E:\29_7_26_UPDATED\WebApp-Sub_Master"

docker compose config --quiet
docker compose build backend frontend
docker compose up -d --force-recreate backend frontend
docker compose ps
docker compose logs --tail=150 backend frontend
```

Do not use `docker compose down -v`; it can remove database and storage volumes.
